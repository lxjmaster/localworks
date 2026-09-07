import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};

/** Fixed vocabulary only: provider errors may contain private prompts, URLs or credentials. */
export function summarizeCodexFailure(params: unknown) {
  const notification = object(params);
  const turn = object(notification.turn);
  const error = object(turn.error ?? notification.error);
  // Live app-server envelopes use camelCase; persisted task_complete evidence
  // uses snake_case. Both must preserve the same bounded failure category.
  const info = error.codexErrorInfo ?? error.codex_error_info;
  const infoName = typeof info === "string" ? info : Object.keys(object(info))[0] ?? "";
  const infoFields = object(object(info)[infoName]);
  const code = infoFields.httpStatusCode ?? infoFields.http_status_code ?? error.httpStatusCode ?? error.http_status_code;
  const httpStatus = Number.isInteger(code) && Number(code) >= 100 && Number(code) <= 599 ? Number(code) : undefined;
  const raw = typeof error.message === "string" ? error.message.slice(0, 65536) : "";
  const searchable = `${infoName} ${raw}`.toLowerCase();
  let category = "unclassified_provider_error";
  let nextAction = "inspect_provider_error_without_replaying_work";
  let retryable = false;
  if (/usage.?limit|rate.?limit|quota|too many requests/.test(searchable) || httpStatus === 429) {
    category = "usage_or_rate_limit";
    nextAction = "check_provider_limits_before_resuming_original_thread";
  } else if (/context.?window|context.?length|maximum context/.test(searchable)) {
    category = "context_limit";
    nextAction = "preserve_artifacts_and_prepare_bounded_context";
  } else if (/unauthorized|authentication|invalid.?api.?key|not.?authenticated/.test(searchable) || httpStatus === 401) {
    category = "authentication";
    nextAction = "repair_authorized_provider_session_without_copying_credentials";
  } else if (/model.?not.?found|unsupported.?model|invalid.?model|model.*not available/.test(searchable)) {
    category = "model_configuration";
    nextAction = "verify_installed_provider_model_capabilities";
  } else if (/sandbox|permission.?denied|access.?denied|forbidden/.test(searchable) || httpStatus === 403) {
    category = "permission_or_sandbox";
    nextAction = "inspect_authorized_scope_do_not_bypass_controls";
  } else if (/connection|network|stream.*(disconnect|closed)|timeout|timed.?out|upstream|service.?unavailable/.test(searchable) || (httpStatus !== undefined && httpStatus >= 500)) {
    category = "transport_or_service";
    nextAction = "reconcile_original_turn_then_retry_same_task";
    retryable = true;
  } else if (/cancel|interrupt/.test(searchable) || turn.status === "interrupted") {
    category = "interrupted";
    nextAction = "verify_owned_processes_stopped_before_continuation";
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([infoName, httpStatus, raw])).digest("hex").slice(0, 20);
  return { category, httpStatus, retryable, fingerprint, nextAction,
    message: `Codex turn failed: ${category}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}; ${nextAction}; diagnostic=${fingerprint}.` };
}
