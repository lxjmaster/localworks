import { spawn, spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface SandboxCommandOptions {
  workspaceRoot: string;
  cwd: string;
  command: string;
  /** Owner-selected host variable names, never a model-controlled override. */
  environment?: string[];
  /** Owner policy only. Omitted/empty means no network; no approval callback exists. */
  allowedDomains?: string[];
  /** Owner-selected existing toolchain directories; never model input. */
  readRoots?: string[];
  /** macOS SDK permits binding/inbound on ALL interfaces, plus loopback egress. */
  allowLocalBinding?: boolean;
  /** Owner-selected existing service state directories; never model input. */
  protectedPaths?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onData?: (data: Buffer) => void;
  /** Called once when output first exceeds retention, before command completion. */
  onOutputTruncated?: () => void;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
}

export class SandboxCleanupError extends Error {
  readonly code = "SANDBOX_CLEANUP_FAILED";
}

export function sandboxWorkerError(message: { error: string; cleanupFailed?: boolean }): Error {
  return message.cleanupFailed === true ? new SandboxCleanupError(message.error)
    : new Error(`Sandbox initialization/execution failed: ${message.error}`);
}

const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
};
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
// These influence the *unsandboxed* wrapper before the OS boundary is entered.
const RESERVED_ENV = /^(?:HOME|TMPDIR|TMP|TEMP|SHELL|ENV|BASH_ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|CLAUDE_.*|SANDBOX_.*|SRT_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;

export function selectSandboxEnvironment(names: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!Array.isArray(names)) throw new Error("environment must explicitly list selected host variable names");
  const selected: NodeJS.ProcessEnv = {
    PATH: DEFAULT_PATH, LANG: "C", LC_ALL: "C",
    // Repository operations must not consume the host's Git identity/config.
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const name of names) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_ENV.test(name)) {
      throw new Error(`Unsafe sandbox environment selection: ${String(name)}`);
    }
    const value = source[name];
    if (value !== undefined) {
      if (value.includes("\0")) throw new Error(`Invalid environment value: ${name}`);
      selected[name] = value;
    }
  }
  return selected;
}

/** Literal policy paths: reject SDK glob syntax instead of accidentally widening access. */
function literal(path: string): string {
  if (/[\0\n\r*?\[\]{}]/.test(path)) throw new Error("Sandbox paths must not contain glob or control characters");
  return path;
}

export function createSandboxCommandPolicy(workspace: string, home: string, app: string, allowedDomains: string[] = [], extras: Pick<SandboxCommandOptions, "readRoots" | "allowLocalBinding" | "protectedPaths"> = {}): SandboxRuntimeConfig {
  [workspace, home, app].forEach(literal);
  const protectedPaths = [
    ...(extras.protectedPaths ?? []),
    ...[".ssh", ".aws", ".gnupg", ".config", ".local/share", ".codex", ".claude", ".devspace", ".localworks", ".netrc", ".npmrc", "Library"].map(p => join(home, p)),
    ...[".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".netrc", ".ssh", ".aws", ".gnupg", ".config", ".codex", ".claude", ".devspace", ".localworks"].map(p => join(workspace, p)),
  ];
  const readRoots = extras.readRoots ?? [];
  [...readRoots, ...protectedPaths].forEach(path => {
    literal(path);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Sandbox policy paths must be canonical absolute paths");
  });
  for (const root of readRoots) {
    if (root === "/" || root === "/Applications" || inside(root, home) ||
        [app, ...protectedPaths].some(p => inside(p, root) || inside(root, p))) {
      throw new Error("readRoots overlaps broad or protected paths");
    }
  }
  if (extras.allowLocalBinding !== undefined && typeof extras.allowLocalBinding !== "boolean") throw new Error("allowLocalBinding must be boolean");
  // The server's installation must never be writable by its own commands.
  if (inside(app, workspace) || inside(workspace, app)) throw new Error("Workspace overlaps the sandbox runner installation");
  if (workspace === "/" || inside(workspace, home) || protectedPaths.some(p => inside(p, workspace))) {
    throw new Error("Workspace overlaps protected home/application paths");
  }
  const allowRead = [workspace, ...readRoots, "/bin", "/sbin", "/usr", "/lib", "/lib64", "/System", "/Library/Apple", "/opt/homebrew", "/dev/null", "/dev/urandom", "/dev/random", "/private/etc/ssl", "/etc/ssl", "/etc/ld.so.cache", ...(process.platform === "darwin" ? ["/private/var/select", "/Library/Preferences/com.apple.dt.Xcode.plist"] : [])];
  if ([...protectedPaths, app].some(p => allowRead.some(root => inside(p, root)))) {
    throw new Error("Protected paths conflict with required sandbox reads");
  }
  return {
    network: { allowedDomains: [...allowedDomains], deniedDomains: [], strictAllowlist: true, allowLocalBinding: extras.allowLocalBinding ?? false, allowAllUnixSockets: false },
    filesystem: {
      denyRead: ["/", ...protectedPaths, app],
      // This is a bounded read policy, NOT workspace-only reads. System programs
      // and libraries remain readable; directory metadata is also visible via SRT.
      allowRead,
      allowWrite: [workspace],
      allowGitConfig: true,
      denyWrite: [...protectedPaths, app, "/tmp/claude", "/private/tmp/claude", join(home, ".npm/_logs"), join(home, ".claude/debug")],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowPty: false,
  };
}

async function canonicalDirectories(paths: string[], name: string): Promise<string[]> {
  if (!Array.isArray(paths)) throw new Error(`${name} must be an array`);
  return Promise.all(paths.map(async path => {
    if (typeof path !== "string" || !isAbsolute(literal(path))) throw new Error(`${name} requires absolute paths`);
    const canonical = literal(await realpath(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error(`${name} requires existing directories`);
    return canonical;
  }));
}

async function selectedToolchain(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const selected = spawnSync("/usr/bin/xcode-select", ["--print-path"], {
    encoding: "utf8", env: { PATH: DEFAULT_PATH }, timeout: 2000, maxBuffer: 4096,
  });
  // Hosts without developer tools can still run commands that do not need them.
  if (selected.status !== 0) return [];
  const directories = await canonicalDirectories([selected.stdout.trim()], "selected Xcode toolchain");
  const developer = directories[0]!;
  if (developer.endsWith(".app/Contents/Developer")) {
    directories.push(...await canonicalDirectories([resolve(developer, "../..")], "selected Xcode application"));
  }
  return directories;
}

// Plain JS runs from --eval in a clean Node process in source AND packaged builds.
// No tsx loader, inherited NODE_OPTIONS, workspace module resolution, policy file,
// or shared SandboxManager singleton crosses this boundary.
const WORKER = String.raw`
import { spawn } from 'node:child_process';
let input = '';
let stopped = false;
let finalize;
process.on('message', message => {
  if (message === 'stop') stopped = true;
  if (message === 'finalize' && finalize) finalize();
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  let manager;
  let cleaning = false;
  try {
    const p = JSON.parse(input);
    const sdk = await import(p.runtime);
    manager = sdk.SandboxManager;
    if (!manager.isSupportedPlatform()) throw new Error('Sandbox runtime unsupported');
    const check = await manager.checkDependenciesAsync();
    if (check.errors.length || check.warnings.length) throw new Error('Sandbox dependencies: ' + [...check.errors, ...check.warnings].join('; '));
    await manager.initialize(sdk.SandboxRuntimeConfigSchema.parse(p.policy), undefined, false);
    if (!manager.isSandboxingEnabled()) throw new Error('Sandbox runtime is disabled');
    // SRT otherwise points TMPDIR at its globally writable /tmp/claude.
    process.env.CLAUDE_CODE_TMPDIR = p.cwd;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    // Even PATH is applied only *inside* the OS boundary: SRT's outer wrapper
    // invokes env by name on macOS. Never let a workspace env executable run
    // before sandbox-exec just because the owner selected PATH.
    const inner = '/usr/bin/env ' + Object.entries(p.environment).map(([key, value]) => quote(key + '=' + value)).join(' ') + ' /bin/bash -c ' + quote(p.command);
    const wrapped = await manager.wrapWithSandboxArgv(inner, '/bin/bash', undefined, undefined, p.cwd);
    if (!wrapped.argv[0]) throw new Error('Sandbox runtime returned no executable');
    if (stopped) {
      cleaning = true;
      await manager.reset();
      process.send({ result: { exitCode: null, signal: null } });
      return;
    }
    const result = await new Promise((resolveResult, reject) => {
      const command = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: p.cwd, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', HOME: p.cwd, TMPDIR: p.cwd },
        stdio: ['ignore', 'inherit', 'inherit'], shell: false, detached: true,
      });
      process.send({ commandPid: command.pid });
      command.once('error', reject);
      // Use exit, not close: background descendants may retain the output pipes.
      command.once('exit', (exitCode, signal) => resolveResult({ exitCode, signal }));
    });
    // The parent kills the command group before SDK teardown, even on normal
    // completion. Waiting for its acknowledgement avoids surviving background jobs.
    await new Promise(resolveFinalize => { finalize = resolveFinalize; process.send({ finished: true }); });
    cleaning = true;
    manager.cleanupAfterCommand();
    await manager.reset();
    process.send({ result });
  } catch (error) {
    let cleanupFailed = cleaning;
    try { if (manager) await manager.reset(); } catch { cleanupFailed = true; }
    process.send({ error: error instanceof Error ? error.message : String(error), cleanupFailed });
  }
});
`;

/**
 * Bounded one-shot execution; callers may retain this promise as a process session.
 * Only macOS/Linux are supported. Failure to initialize never runs an unwrapped
 * command. Each worker owns one runtime/proxy policy, including concurrent calls.
 * POSIX process-group termination covers normal shell descendants (including
 * background jobs); deliberate session-escaping daemons are not a supported job.
 */
export async function runSandboxCommand(options: SandboxCommandOptions): Promise<SandboxCommandResult> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`Sandbox commands unsupported on ${process.platform}`);
  const environment = selectSandboxEnvironment(options.environment ?? []);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be 1..600000");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) throw new Error("maxOutputBytes must be 1..16777216");
  if (typeof options.command !== "string" || options.command.includes("\0") || Buffer.byteLength(options.command) > 1024 * 1024) throw new Error("Invalid shell command");
  const workspace = literal(await realpath(resolve(options.workspaceRoot)));
  const cwd = literal(await realpath(resolve(workspace, options.cwd)));
  if (!inside(workspace, cwd) || !(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory within workspaceRoot");
  const home = await realpath(homedir());
  const app = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (options.allowLocalBinding && process.platform !== "darwin") {
    throw new Error("Installed sandbox SDK cannot enforce host-reachable local listening on this platform; allowLocalBinding is supported only on macOS and permits all bind interfaces, not loopback-only");
  }
  const [readRoots, protectedPaths, discovered] = await Promise.all([
    canonicalDirectories(options.readRoots ?? [], "readRoots"),
    canonicalDirectories(options.protectedPaths ?? [], "protectedPaths"),
    selectedToolchain(),
  ]);
  const policy = createSandboxCommandPolicy(workspace, home, app, options.allowedDomains, {
    readRoots: [...new Set([...readRoots, ...discovered])], protectedPaths, allowLocalBinding: options.allowLocalBinding,
  });
  // Apple shims otherwise probe /var/select/developer_dir even when that link
  // does not exist. Use the owner's actual selection, discovered outside the
  // sandbox with an absolute executable and a fixed environment.
  if (discovered[0] && environment.DEVELOPER_DIR === undefined) environment.DEVELOPER_DIR = discovered[0];
  const result: SandboxCommandResult = { exitCode: null, signal: null, output: "", timedOut: false, aborted: false, outputTruncated: false };
  if (options.signal?.aborted) return { ...result, aborted: true };
  return new Promise((resolveResult, reject) => {
    // The broker environment is fixed; selected variables go ONLY to the wrapped
    // process. PATH cannot redirect the broker's dependency probes or shell.
    const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER], {
      cwd: app, env: { PATH: DEFAULT_PATH, HOME: home, LANG: "C", LC_ALL: "C" },
      detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let error: Error | undefined;
    let reported = false;
    let workerKilled = false;
    let commandPid: number | undefined;
    let commandKilled = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const killGroup = (pid: number) => {
      try { process.kill(-pid, "SIGKILL"); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
        // macOS reports EPERM for groups containing only dead/zombie members.
        // Verify that state instead of swallowing a genuine termination failure.
        if ((cause as NodeJS.ErrnoException).code === "EPERM") {
          const ps = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", env: { PATH: DEFAULT_PATH }, timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
          if (ps.status === 0 && !ps.stdout.split("\n").some(line => {
            const fields = line.trim().split(/\s+/);
            return Number(fields[1]) === pid && !fields[2]?.startsWith("Z");
          })) return;
        }
        error = new SandboxCleanupError(`Sandbox process group cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    };
    const killCommand = () => {
      if (commandPid && !commandKilled) { commandKilled = true; killGroup(commandPid); }
    };
    const kill = () => {
      killCommand();
      if (child.pid && !workerKilled) { workerKilled = true; killGroup(child.pid); }
    };
    const send = (message: string) => { if (child.connected) child.send(message, () => {}); };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killCommand();
      send("stop");
      // Allow bounded runtime cleanup; a hung initialization/reset cannot defeat
      // the owner's timeout. A forced teardown rejects, rather than claim cleanup.
      forceTimer = setTimeout(() => {
        error = new SandboxCleanupError("Sandbox cleanup exceeded 2000ms");
        kill();
        // An unsupported daemon that escaped its session may retain these FDs.
        // Do not let that turn a bounded failure into a promise that never settles.
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, 2000);
    };
    const abort = () => { result.aborted = true; stop(); };
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const markOutputTruncated = () => {
      if (result.outputTruncated) return;
      result.outputTruncated = true;
      options.onOutputTruncated?.();
    };
    const data = (chunk: Buffer) => {
      const accepted = chunk.subarray(0, Math.max(0, maxOutputBytes - bytes));
      if (accepted.length) {
        chunks.push(accepted); bytes += accepted.length;
        try { options.onData?.(accepted); }
        catch (cause) { error = cause instanceof Error ? cause : new Error(String(cause)); stop(); }
      }
      // Keep draining after retention fills: output volume must not kill builds.
      if (accepted.length < chunk.length) {
        try { markOutputTruncated(); }
        catch (cause) { error = cause instanceof Error ? cause : new Error(String(cause)); stop(); }
      }
    };
    child.stdout!.on("data", data);
    child.stderr!.on("data", data);
    child.stdin!.on("error", cause => { if ((cause as NodeJS.ErrnoException).code !== "EPIPE") { error = cause; kill(); } });
    child.once("error", cause => { error = cause; });
    child.on("message", (message: unknown) => {
      const value = message as { commandPid?: number; finished?: boolean; result?: { exitCode: number | null; signal: string | null }; error?: string; cleanupFailed?: boolean };
      if (value.commandPid) { commandPid = value.commandPid; if (stopping) killCommand(); return; }
      if (value.finished) { killCommand(); send("finalize"); return; }
      if (value.error) error = sandboxWorkerError({ error: value.error, cleanupFailed: value.cleanupFailed });
      else if (value.result) { Object.assign(result, value.result); reported = true; }
      else error = new Error("Invalid sandbox worker response");
      kill(); // Also remove background jobs on normal completion.
    });
    child.once("exit", kill);
    child.once("close", () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
      const decoded = Buffer.from(Buffer.concat(chunks).toString("utf8"));
      if (decoded.length > maxOutputBytes) {
        try { markOutputTruncated(); }
        catch (cause) { error = cause instanceof Error ? cause : new Error(String(cause)); }
      }
      result.output = new StringDecoder("utf8").write(decoded.subarray(0, maxOutputBytes));
      if (error) reject(error);
      else if (!reported && !result.timedOut && !result.aborted) reject(new Error(`Sandbox worker exited without a result: ${result.output}`));
      else resolveResult(result);
    });
    child.stdin!.end(JSON.stringify({ runtime: import.meta.resolve("@anthropic-ai/sandbox-runtime"), policy, command: options.command, cwd, environment }));
  });
}
