# 远端缺少执行回执：诊断与恢复（2026-09-07）

本轮检查发现两个不同层面的问题，不能混为一次模型执行失败。

1. 旧 serving stdout 在 19:21:47/48（UTC+8）记录了 `/mcp` HTTP 200，但没有 MCP method、工具 action、RPC/工具错误或响应形状。HTTP 200 只能证明 HTTP 返回，无法还原当时远端是否拿到有效回执。旧 lifecycle JSONL 的最后记录是 10:01:32；不能据此确定进程退出原因。
2. 本轮通过沙箱外的本机直连检查，确认 `127.0.0.1:7676` 连接被拒绝，没有可用 serving listener。默认代理路径曾返回 502，与直连拒绝分开记录。持久状态中的 active agent、claim、waiter 均为空；没有为了恢复服务清锁或终止 worker。

没有读取模型 prompt、私有思维链、凭据正文或远端业务源码。旧 stdout 仅投影时间、事件、工具类型、状态等字段，未回显命令/工具正文，也未汇总其他 conversation 的 token。没有足够历史日志确定最初那个 HTTP 200 内部的 MCP 结果，不能事后编造错误原因。

## 新增日志

新增 `mcp-request-diagnostics.ts`，在认证前、Express 已解析请求之后观察 `/mcp`；因此 schema/auth 拒绝即使没有进入工具 handler，也会留下交换记录。`mcp_exchange_started` / `mcp_exchange_finished` 使用已有 HTTP requestId，记录白名单 method/tool/action、合法 workspace/run/agent 标识、conversation hash、HTTP 状态、断线标记、响应字节数/哈希、JSON/SSE 格式、RPC 错误码、工具错误标记、白名单错误码和错误指纹。

结果检查最多暂存 64 KiB；超限明确为 `over_limit`，不将未知结果当成空回执。日志仅保存统计与结构标志，不保存请求参数、返回正文、原始异常、headers、query 或 credentials。`receiptPresent` 是结果中回执结构字段的指示，不是 acceptance passed 或用户界面成功的证据。SSE、超大响应、连接中断以及 logger 自身失败均保持原 HTTP 行为，不自动重放请求。

通过现有 `ServerDiagnostics.record` 持久保存，复用已有 1 MiB 轮转和一个备份；普通 stdout 同时保留。CLI 和 direct server 两个入口均接入。尊重 `logging.requests` 与 `logging.level`，本轮没有修改认证或日志配置。

## 验证与恢复边界

真实现代 HTTP MCP 测试覆盖 HTTP 200 的正常回执、工具错误、schema 拒绝；同时覆盖 SSE、超大响应、断线、日志失败和 secret 不落日志。类型检查与独立 Vite/TypeScript 生产构建通过。

首轮完整套件在沙箱内 220 项中有 1 项失败，位于既有 `process-sessions.test.ts:160` 的 Windows 子进程中断断言。收据保留为 `2026-09-07T11-34-51-940Z-188e8a25-99a2-4094-b993-2a5102543583`；没有改掉该断言或修改业务终止逻辑掩盖失败。最终沙箱外复验与真实服务恢复结果见 `releases/mcp-receipt-diagnostics-20260907/receipt.json`。

候选入口为 `releases/mcp-receipt-diagnostics-20260907/dist/cli.js serve`，保留原配置/状态目录、OAuth 数据和用户拥有的隧道。原 serving 实例已不可用，因此恢复只启动经过验证的 CLI，不运行以前被拒绝的维护脚本，不删除旧 claim，不替换 Desktop/隧道，不发起模型任务。原工作区 dirty 改动保留；本轮未提交或 push。

最终沙箱外完整套件 **220 项：215 passed、0 failed、5 skipped**，退出码 0；收据 `2026-09-07T11-55-16-676Z-f819c9a8-f0d7-48e8-aed0-3566f196b8ce`，sourceSha256 为 `c9fad7b5f79b1670e4947b435a6e2e26bee10ff6d46a939ca811b0a82d47dd45`。与沙箱内失败运行的源码哈希相同，环境改变后中断测试通过。

19:59:24（UTC+8）新实例 **PID 14092** 记录 `server_listening`，本机 `/healthz` 返回 200。20:00:21/22 通过实际远端连接完成 `read` 与 `work_task get`：均 HTTP 200、SSE、`toolError=false`；响应分别为 540/2017 字节，get 的 `receiptPresent=true`。远端实际可解析的目标 run 回执为 running/pending、usage not_used；没有为了呈现成功修改该历史 run 的验收状态。新实例还持续记录 heartbeat、pendingRequests=0。脱敏线上证据保存为 `releases/mcp-receipt-diagnostics-20260907/live-diagnostics.json`。
