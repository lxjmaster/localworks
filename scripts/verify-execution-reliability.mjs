// Compiled MCP smoke only. No listener, daemon startup, model, or live state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Result } from "better-result";

assert(process.argv[2], "Pass an isolated compiled dist directory");
const dist = resolve(process.argv[2]);
const compiled = (name) => import(pathToFileURL(join(dist, name)).href);
const { registerAgentTaskTool } = await compiled("tool-surfaces/agent-task.js");
const { LocalAgentStore } = await compiled("local-agent-store.js");
const { resolveDaemonEntrypoint } = await compiled("local-agent-client.js");
assert.equal(resolveDaemonEntrypoint(), join(dist, "local-agent-daemon-main.js"));
const root = mkdtempSync(join(tmpdir(), "devspace-compiled-observe-"));
const store = new LocalAgentStore(root);
const record = store.create({ workspaceId: "fixture", workspaceRoot: root, provider: "codex", profileName: "codex" });
store.update(record.id, { status: "idle", latestResponse: "compiled fixture result" });
const server = new McpServer({ name: "compiled-fixture", version: "1" });
const client = new Client({ name: "compiled-host", version: "1" });
try {
  registerAgentTaskTool({ server, config: { stateDir: root, subagents: {} }, processSessions: {},
    workspaces: { getWorkspace: () => ({ id: "fixture", root }) } }, {
    get: async () => Result.ok(store.getById(record.id)), list: async () => Result.ok([]),
    start: async () => { throw new Error("Unexpected inference"); }, continue: async () => { throw new Error("Unexpected inference"); },
  });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const schema = (await client.listTools()).tools.find((tool) => tool.name === "agent_task").inputSchema;
  assert.equal(schema.properties.waitMs.maximum, 25000);
  assert.match(schema.properties.includeResponse.description, /repeatable/);
  const call = async (extra = {}) => {
    const result = await client.callTool({ name: "agent_task", arguments: { workspaceId: "fixture", action: "observe", agentId: record.id, waitMs: 0, ...extra } });
    assert(!result.isError); return JSON.parse(result.content[0].text);
  };
  const brief = await call(); assert.equal(brief.response, undefined); assert.equal(brief.nextAction.includeResponse, true);
  const recovered = await call({ includeResponse: true, knownRevision: brief.revision });
  assert.equal(recovered.response, "compiled fixture result"); assert.equal(recovered.acceptanceStatus, "unknown");
  assert.equal(recovered.nextAction.action, "review_result");
  assert.equal((await call({ includeResponse: true, knownRevision: brief.revision })).response, recovered.response);
  console.log(JSON.stringify({ compiledMcpSmoke: "passed", daemonEntrypoint: resolveDaemonEntrypoint(), providerInvocations: 0 }));
} finally {
  await client.close(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true });
}
