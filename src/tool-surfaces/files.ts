import * as z from "zod/v4";
import { ExecutionConflictError } from "../execution-coordinator.js";
import { trackedWork } from "./work-task.js";
import { executeFileOperation, MAX_FILE_BYTES, type FileOperation } from "../filesystem-operations.js";
import { workspaceIdDescription, type ToolRegistrationContext } from "./types.js";

// SDK clients may validate structured errors too. Keep a real object contract
// with tool-specific states; payload fields are conditional on status.
function fileOutputSchema(statuses: [string, ...string[]], fields: z.ZodRawShape = {}) {
  return z.object({
    path: z.string().describe("Requested relative path, including on failure."),
    status: z.enum([...statuses, "error"]),
    ...fields,
    error: z.object({ code: z.string(), message: z.string(), claimId: z.string().optional(), agentId: z.string().optional() })
      .optional().describe("Present when status is error; the MCP result also has isError: true."),
    nextAction: z.object({ tool: z.enum(["agent_query", "agent_task"]), action: z.literal("claims"), workspaceId: z.string() })
      .optional().describe("Present on execution conflicts."),
    guidance: z.string().optional().describe("Recovery guidance on execution conflicts."),
  });
}

const fileVersionOutput = {
  bytes: z.number().int().min(0).max(MAX_FILE_BYTES).optional().describe("Required on success: UTF-8 byte count."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Required on success: full-file SHA-256."),
};

/** General file tools; registration is deliberately left to the integrating surface. */
export function registerFileTools({ server, config, workspaces, processSessions }: ToolRegistrationContext): void {
  const common = {
    workspaceId: z.string().min(1).describe(workspaceIdDescription),
    workRunId: z.string().optional().describe("Optional work record identifier for this operation."),
    path: z.string().min(1).max(1024).describe("Relative file path inside the workspace. Parents must exist; leaf symlinks are rejected."),
  };
  const version = { expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).describe("SHA-256 from the last read_file; checked inside the mutation claim.") };
  const text = z.string().max(MAX_FILE_BYTES).describe("UTF-8 text without NUL, at most 1 MiB in bytes.");
  const limits = " Regular UTF-8 files only, at most 1 MiB. Workspace claims coordinate DevSpace, not external writers: no atomic filesystem CAS. External edits require re-reading.";
  const annotations = (read: boolean, destructive = !read) => ({ readOnlyHint: read, destructiveHint: destructive, idempotentHint: read, openWorldHint: false });
  const run = async (workspaceId: string, input: FileOperation & { workRunId?: string }) => {
    let workspace: ReturnType<typeof workspaces.getWorkspace> | undefined;
    try {
      workspace = workspaces.getWorkspace(workspaceId);
      const { root, id } = workspace;
      const { workRunId, ...fileInput } = input;
      const operation = () => executeFileOperation(root, fileInput);
      const execute = () => input.action === "read"
        ? processSessions.readWorkspace(root, operation)
        : processSessions.mutate(root, operation);
      const kind = input.action === "create_directory" ? input.action : `${input.action}_file`;
      const result = workRunId ? await trackedWork(config.stateDir, workRunId, { root, workspaceId: id }, kind, execute) : await execute();
      const value = input.action === "read" ? { ...result, status: "read" } : result;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: value };
    } catch (error) {
      if (error instanceof ExecutionConflictError && workspace) {
        // Error messages contain raw claim IDs, including owners outside this workspace.
        // Only identifiers read back through the scoped coordinator view are public.
        const owner = processSessions.executionCoordinator?.inspect(workspace.root).find((claim) => claim.id === error.claimId);
        const value = { path: input.path, status: "error", error: { code: error.code,
          message: "Execution is occupied; inspect workspace claims and reconcile before retrying.",
          ...(owner ? { claimId: owner.id, ...(owner.agentId ? { agentId: owner.agentId } : {}) } : {}) },
          nextAction: { tool: config?.toolMode === "web" ? "agent_query" : "agent_task", action: "claims", workspaceId },
          guidance: "Wait for the owner or reconcile interrupted work. Never steal active claims or automatically replay writes." };
        const {path: _path,...legacy}=value;
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(legacy) }], structuredContent: value };
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      const message = code ? `File operation failed (${code}).` : (error instanceof Error ? error.message : "File operation failed.").slice(0, 300);
      const value = { path: input.path, status: "error", error: { code: code ?? "FILE_OPERATION_FAILED", message } };
      const {path: _path,...legacy}=value;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(legacy) }], structuredContent: value };
    }
  };
  server.registerTool("read_file", {
    outputSchema: fileOutputSchema(["read"], { ...fileVersionOutput, content: z.string().max(MAX_FILE_BYTES).optional().describe("Required on read success: complete UTF-8 text.") }),
    description: "Read complete bounded text and its SHA-256. Oversized files fail without truncation." + limits,
    inputSchema: common, annotations: annotations(true),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "read", ...input }));
  server.registerTool("create_file", {
    outputSchema: fileOutputSchema(["created"], fileVersionOutput),
    description: "Create a new file exclusively; never overwrite an existing entry. I/O failure may leave partial content." + limits,
    inputSchema: { ...common, content: text }, annotations: annotations(false, false),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "create", ...input }));
  server.registerTool("create_directory", {
    outputSchema: fileOutputSchema(["created", "exists"]),
    description: "Create one workspace directory without recursion; parents must exist. An existing directory succeeds unchanged; files and leaf symlinks fail. External ancestor changes can race confinement checks.",
    inputSchema: common, annotations: { ...annotations(false, false), idempotentHint: true },
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "create_directory", ...input }));
  server.registerTool("edit_file", {
    outputSchema: fileOutputSchema(["updated"], fileVersionOutput),
    description: "Apply exact oldText/newText edits. Each oldText must match once in the original file; edits must not overlap. Stage then rename, preserving permission bits but replacing file identity and other metadata." + limits,
    inputSchema: { ...common, ...version, edits: z.array(z.object({ oldText: text.min(1), newText: text }).strict()).min(1).max(100) },
    annotations: annotations(false),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "edit", ...input }));
  server.registerTool("replace_file", {
    outputSchema: fileOutputSchema(["updated"], fileVersionOutput),
    description: "Replace an existing file's complete content after version validation. Stage then rename, preserving permission bits but replacing file identity and other metadata." + limits,
    inputSchema: { ...common, ...version, content: text }, annotations: annotations(false),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "replace", ...input }));
  server.registerTool("move_file", {
    outputSchema: fileOutputSchema(["moved"], { sha256: fileVersionOutput.sha256, destination: z.string().optional().describe("Required on move success: destination relative path.") }),
    description: "Move a version-checked source without overwriting any destination entry. Uses link then unlink, not atomic rename; unlink failure leaves both names. Cross-device moves fail." + limits,
    inputSchema: { ...common, ...version, destination: common.path }, annotations: annotations(false),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "move", ...input }));
  server.registerTool("delete_file", {
    outputSchema: fileOutputSchema(["deleted"]),
    description: "Delete one existing file after version validation." + limits,
    inputSchema: { ...common, ...version }, annotations: annotations(false),
  }, ({ workspaceId, ...input }) => run(workspaceId, { action: "delete", ...input }));
}
