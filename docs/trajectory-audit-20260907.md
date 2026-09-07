# Trajectory 审查与交付收据（2026-09-07）

本轮新增紧凑的 work-run 状态读取、兼容完整历史的分页，以及可校验的交付记录。实现复用现有 `console_operations`/`work_task record`，没有引入另一个调度器或存储平台。源码及独立候选验收与运行中的 MCP/agentd 分开；本轮没有部署或重启服务。

> **主控范围更正（2026-09-07 15:51）**：下文 worker 自行创建的 `run_301f69671df142799eb9c18ee2d20a29` 属于子调用的 conversation，不是本 ChatGPT 会话的父运行；它的 0 executions 不能代表本轮没消耗 Codex。本轮真实父 run 为 `run_3f1a272be36b473a8534ed54ab530a6f`，对应 agent `agt_ed9f7c08`；正式账本统计 complete：input 2,321,766、output 29,160、total 2,350,926，缓存输入2,219,648已包含在input中。worker完成摘要里的“0/not_used”仅描述其子run，作为整个任务用量结论是错误的。以下原始观察保留为历史，主控补充数据见文末。

## 证据范围与量化限制

起始 HEAD 为 `7a4b4a2ebf77a9ccc32be2a3874310e5627bafbe`。先核对了当前 AGENTS、git status、指定的三份输入及相邻 ledger、工具注册、claim、测试和测试收据实现。三份输入的 SHA-256 均与用户提供值完全一致。没有全仓聊天/配置扫描，没有读取 provider prompt、私有思维链、原始响应、凭据或云/VM 工程。

当前 MCP `begin` 返回的 origin 是 `chatgpt_mcp`，conversationHash 为 `274828b6ba1b732e3ead5237`，本轮 run 为 `run_301f69671df142799eb9c18ee2d20a29`。只读 SQLite 查询使用这两个 origin 字段的精确谓词，再按匹配 run 查询操作类型、状态、创建/结束时间及 execution usage quality。查询不调用会自动迁移数据库的 `WorkLedger` 构造器；只读连接不写运行状态。

07:39:45Z 的持久快照只匹配本次审查 run，历史 operations 为 **0**、executions 为 **0**。所以无法按本 conversation 量化用户描述的旧轮询、耗时或 token 热点；已请求原 conversationHash/workRunId，但不能用另一个聊天或全项目账单补齐。没有把 yaxian 的另一聊天计入。`console_operations` 没有退出码字段，退出码明确为 unavailable，不能从 completed/failed 推断 0/1。当前 ChatGPT 主控通过本地工具执行的操作不自动进入这份 MCP ledger，0 条记录不等于本轮没有工作。主控自身模型 token 也不在该 ledger 的计量范围。

元数据原始脱敏收据位于 `releases/trajectory-audit-20260907/metadata.json`；附有可检查的白名单查询脚本 `collect-metadata.mjs`。历史热点仅作为用户提供的定性证据；选择修复的依据是已读源码明确存在的无界历史返回和缺失类型化交付读取，不能声称这是已经量化排序后的线上最大热点。

合成验证与历史实测严格区分：新集成测试产生 10,000 operations 和 10,000 executions，逐页核对无遗漏/重复，并要求无交付正文的 snapshot 小于 1,500 字符。独立生产候选的空 run snapshot 实测为 640 字节。这些数字是 fixture 的输出边界，不是线上 token/延迟节省百分比。

## 责任分类

| 现象 | 事实与责任边界 | 本轮处理 |
| --- | --- | --- |
| APK 已完成却报没有 APK；worker completed 当成整体验收 passed | 主控交付判断失误；原 ledger 已能保留逐项 evidence，不能归因于缺少基本存储 | 新增默认可读的已验证产物层，但主控仍须分别报告 execution、acceptance、artifacts |
| 反复 resources 发现、旧 revision 短轮询 | 主要是主控调用规范问题；现有 observe 已有 bounded longpoll | 不重写发现/轮询；复用现有行为 |
| 每次 work_task.get 返回全部 operations/turns | 当前协议返回形状与工程实现的明确缺口 | 新 snapshot 和 history；旧 get 保留 |
| 全量终端正文被安全检查阻断，误报整个任务失败 | 安全检查属于外部权限边界；主控误读拒绝属于操作错误 | 默认摘要不依赖终端正文；拒绝仍保留，不换路径取回被拒绝输出 |
| capture 后源码变化产生 STALE_CONTEXT | 并发写入/过期引用；现有版本检查是必要边界 | 发布时校验显式文件 hash，读取已发布账本不偷读活动源码；不能宣称外部编辑被锁住 |
| flat key/owners、vm-e2e/vm-test-UUID 不一致 | 消费契约问题；应在执行前校验，非模型推理失败 | 新通用交付 schema 会拒绝未知字段/版本/状态；未实现 VoiceMemory 的业务 handoff validator |
| 活跃 writer 阻止前台读 checkout | 正确的 claim 排他性，不是应该删除的锁 | snapshot 可读之前已发布记录；发布本身继续遵守 read claim |
| README 与实际部署结果不一致 | 主控维护交付说明的责任，真实 current-delivery 应独立验收 | 不读取/修改云工程，不把 README 当运行时证据 |
| PowerShell/CMD/WSL UNC、后台句柄 | shell 能力/进程生命周期问题，部分属于目标工程 | 本轮不改 exec/shell、后台进程或超时策略 |
| quota、COS 403、权限/安全拒绝、usage unavailable | provider/权限或计量边界 | 不绕过、不补零，不重放部署/迁移 |
| 源码修复被当成 live 已加载 | 主控部署与版本核验失误，也有 runtime 指纹能力缺口 | 明确候选/host schema/live 边界；完整 runtime capabilities 工具未实现 |

## 已有修复：本轮复用

指定 trace 与实际相邻代码确认：quota preflight、可选 RPC 5 秒上限、usage 与 progress 分离、客户端项目自动创建与回读、过期/删除 checkout 检查、控制错误分类和结构化 `test-with-receipt` 已存在。原 ledger 的 acceptance/evidence 分层与失败保留成功 evidence 也已存在，本轮没有把它们算成新增功能。Desktop 自动创建源码 CLI 已验收不等于本次运行实例已加载；原资料中的 UI/线程归属边界继续有效。

## 本轮新增契约

`work_task action=snapshot` 返回固定 schema/version、run 身份、稳定 revision、executionStatus、acceptanceStatus、计数、最新 typed delivery、最近带已验证产物的 typed delivery、匹配状态和固定修复指引。不返回 title、summary、任意旧 evidence、原始命令、模型正文或历史 turns。无 publication 时为 unknown，不按文件名猜测 APK 成功。失败验收或后续无产物的检查不会清除同 run 已发布的 APK。另一个 run 的产物不会被顺带选入。

`agent_task observe` 默认附加同 run 的 `completionSnapshot`，不要求 `includeResponse=true`。终态/相同 revision/重新连接仍能重复取得它。新观察 revision 根据交付和执行状态生成，排除 usage、elapsed、metadata updatedAt；不更新 ledger 来强制刷新。旧的显式终端正文/完整 receipt 仍保留。

`work_task action=history` 每类最多 100 条，默认 50，operations/turns 以 rowid 确定排序，并绑定 run 和 ledger revision。跨 run cursor 拒绝；期间数据变化返回 `STALE_CURSOR`，要求主控从第一页重新读取并按 ID 合并，不静默跳过或确认事件。它是现有记录的 revision-bound 分页，**不是新增事件溯源日志**。活跃 run 经常变化时可以稍后读稳定历史；相同 cursor/revision 可重复恢复。用户显式 `action=get` 仍得到旧完整历史，没有删事件、改旧返回字段或强制截断旧 consumer。

`work_task action=record` 的可选 `delivery` 使用 `devspace.delivery` v1：`sourceHash`、显式 sources、`passed|failed|not_run`、显式 artifacts。`sourceHash` 是 `SHA256(JSON.stringify(sources))`，数组顺序与 `{path,sha256}` 字段顺序固定；它只代表所选文件 manifest，不冒充全仓 Git commit。记录仍存入原 bounded evidence，序列化上限 1,200 字符。不能混用任意 legacy label/evidence/status，也不能用普通 record 伪造保留的 `delivery.v1` kind。

发布只哈希明确选择的公开文件：在原 workspace 的 realpath scope 验证、拒绝路径穿越/越界 junction 和明显的配置/密钥路径、核对文件哈希与 source manifest、拒绝未知 schema/version/state。只读取显式选中的文件，不跟随文件内部引用；不调用 shell、模型或部署。`passed` 表示主控显式声明已完成验证并通过文件哈希绑定，不代表 DevSpace 独立执行过 Android 安装/E2E。`expectedSourceHash` 让消费者在不读源码时发现过期交付；未提供则为 unchecked，不是当前部署通过。摘要中的 verifiedAt 是发布时刻，不保证可变路径如今仍是相同内容。

发布继续获取普通 cooperative read claim，**活跃 writer 时新发布会被拒绝**；没有借用 claimId、偷取 claim 或自动打开 worker checkout。只读 summary 从 ledger 恢复旧 publication，在 writer 活跃、甚至原源码/产物已删除时也可读。本轮实现的是 host 验证后发布和跨阶段的安全读侧，不是 B 所述“活跃写 worker 主动发布”的完整生产者身份契约。后者及特定 handoff 字段验证仍待单独设计，不把局部实现冒充完成。

## 验证及源码对应

源码提交为 `de6d40ede1cb0a0a55709c14da8347eff8b267e4`。详见同行结构化收据 `trajectory-audit-20260907.receipt.json`：包含源提交、逐文件哈希、全量测试/日志哈希、候选树哈希和验证边界。初轮定向测试有 2 项失败，保留原收据：直接将 usage ledger revision 用于观察导致回归，以及测试端错误解析 MCP schema 拒绝。修正后第二轮 18/18 通过；之后扩展了产物保留、分页 usage 语义和默认 observe 断线恢复断言，再执行最终全量套件。

最终 `pnpm test` 使用既有 `test-with-receipt` 完整运行 76 个文件、218 项：213 passed、0 failed、5 skipped，退出码 0，约 166.6 秒。前后 sourceSha256 均为 `967966ae70afda13db274f861c4fea96e0f4b6291936d0f23e75ea254efbe174`；收据 ID 为 `2026-09-07T07-40-20-650Z-17b931ee-a383-49d0-8431-3f20a7af7b5e`。`pnpm typecheck` 退出码 0。测试运行时尚未提交，因此原测试收据保留基线 sourceCommit `7a4b4a2…`；之后的源码提交没有更改被测文件字节。

独立候选路径为 `releases/trajectory-audit-20260907/candidate`，通过 Vite 和 TypeScript 指定 outDir 构建，未运行会 clean 当前 dist 的 `pnpm build`。候选共 410 个文件，树哈希 `1cd69e7f4ddb46c38cf1a82f01ff90cf743a66679e31cbc0861e45e456fa759e`。候选还用编译后 JS 在真正 InMemoryTransport 上验证了 tools/list、snapshot 和 history，并生成 `candidate-verification.json`/`build-manifest.json`。没有渲染新 UI，因为本轮未改 UI；构建 UI 通过不等于界面或真实 MCP host 的新 schema 已验收。

当前 host 给本轮的 work_task 声明仍只有 begin/record/finish/get/list；本轮没有把新 action 调到老运行服务上猜测成功。候选 tools/list 指纹证明的只是候选 in-memory 实例。运行中 worker 的加载 build、host 刷新、Windows/WSL shell capability 不在本轮验收范围。

起始已有 dirty 文件：`docs/gotchas.md`、`src/cli.ts`、`src/server-shutdown.test.ts`、`src/server-shutdown.ts`、`src/server.ts`，以及未跟踪的 `docs/server-diagnostics.md`、`src/agentd-preflight.ts`、`src/inspect-agent-failure.ts`、`src/server-diagnostics.test.ts`、`src/server-diagnostics.ts`。本轮未编辑/提交这些文件；全量测试和候选包含当时的实际 dirty 工作树，不能仅凭 HEAD 重现全部字节，应使用测试 sourceSha256 和文件清单判断。

## 未实现与后续维护边界

完整 worker 主动发布身份、项目特定 handoff validator、runtime capabilities/version fingerprint、shell 选择及后台服务 API 均未实现。主控仍须正确选择已有工具、复用 workspace/run/revision、核对 acceptance 与历史产物、维护准确说明；这些不能甩给工具。

本轮未调用任何原先被拒绝的维护脚本，也没有改用包装/另一 shell 重做。未停止/替换 MCP、agentd、Desktop、隧道或任何云任务，没有删除 claim、自动强退任务或重放部署/迁移。只有所有相关任务停止后，主控通过正常、已有授权且未被阻断的维护机制，才能处理安装与实际 host schema 验证。此次交付止于源码与独立候选。

交付时调用现有 `work_task finish`，服务返回 `WORK_STATE: Managed claims/waiters remain; inspect and reconcile them before closing work.` 因此本次 ledger run 仍是 running/pending，不能报告为已成功关闭。此前 validation record 已持久化；测试/候选验收通过与 ledger 关闭拒绝分别记录。本轮不清理这些 claim、不替换进程、不轮询等待关闭，也不把拒绝改成测试失败。

## 主控按真实父会话取得的轨迹元数据

`scripts/inspect-conversation-trajectory.ts` 以工具实际返回的父run为锚点，从只读账本取得其origin，再按相同entryPoint/conversationHash精确选择；没有用整个项目或账号替代。2026-09-07 07:51:24Z快照覆盖32个匹配run、568个记录操作、25个managed执行，明确不包含未记录成operation的工具发现或observe，也不自动并入没有父关联的worker子conversation。因此这是本会话可归属账本子集，不是全部UI交互的完整轨迹。

| 可核对数据 | 数量与解释 |
|---|---|
| 直接文件读取 |142次，7次标记failed；不能把全部读取认定为浪费|
| workspace_context |149次，9次标记failed，说明主控上下文往返非常细碎|
| 受管命令 |180次，35次标记failed；失败可能是构建、负例、外部状态或工具问题，不能直接称35个DevSpace bug|
| apply_patch |89次，5次标记failed；上下文过期和原文不匹配均需保留真实原因|
| 最长两条已结束命令 |1,668,524ms与737,879ms，约27分49秒和12分18秒；只表示记录生命周期，不等于模型计算时间|
| 本次快照的执行终态 |12completed、10failed、2cancelled、1running；accepted/已部署不能从这里推导|
| 历史用量完整性 |13条不完整或尚运行；已知独立delta合计30,266,742tokens只是可归属部分，不是精确会话总额或账单，亦不是本轮新增消耗|

快照 `releases/trajectory-audit-20260907/parent-conversation-metadata.json`，SHA256 `59b53ab69ec626ebeb309b9db39cb79a462991cfee4ec150fa42cb6127a022c7`。各操作duration可能重叠，不能求和当总等待时间；脚本不读取prompt、模型正文、私有思维、凭据或业务数据，零推理。

本轮还暴露了**父子任务归属断裂**：worker内部重新begin了另一个conversation，并试图在自己仍持有写claim时finish，既无法代表父任务用量，又被正确的在途保护拒绝。应由主控持有唯一父run、worker回报自身execution结果，不为记账再次创建互不关联的顶层run。自动传播已验证父run/执行身份是下一项需要实现的工具能力；本轮仅完成精确锚点检查与纠错，没有伪称已实现安全的跨进程继承。

worker停止后，主控尝试按其返回的子run通过当前工作区原生结项，工具返回 `WORK_STATE: Work run is outside this workspace scope`。未更换工作区或改账本绕过；该子run的归属修复未执行，父run仍按自身scope正常结项。该事实再次说明不能将子工具会话的局部run自动当作主控父run。
