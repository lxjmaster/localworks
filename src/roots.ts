import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export function normalizeWslPath(path: string): string | undefined {
  const match = /^\\\\(?:\?\\UNC\\)?(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i.exec(win32.normalize(path));
  if (!match) return undefined;
  return `\\\\wsl.localhost\\${match[1]!.toLowerCase()}${match[2]}`;
}

export function canonicalPathIdentity(path: string): string {
  return process.platform === "win32" ? normalizeWslPath(path) ?? path.toLowerCase() : path;
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  if (process.platform === "win32") {
    const wslPath = normalizeWslPath(resolvedPath);
    const wslRoot = normalizeWslPath(resolvedRoot);
    if (wslPath || wslRoot) {
      if (!wslPath || !wslRoot) return false;
      return wslPath === wslRoot || wslPath.startsWith(`${wslRoot.replace(/\\$/, "")}\\`);
    }
  }
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith("..") &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}
