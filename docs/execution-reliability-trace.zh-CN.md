# DevSpace 执行可靠性：本机证据、修复与启用边界

本次只实现并验证，不启用线上新代码。基线为 `f3e4baa`；不重启 DevSpace、agentd 或 tunnel，不触碰 yaxian 源码、发布产物或模拟器。没有真实付费模型 benchmark，也没有新增后台调度 worker。

## 证据范围与可复核数据

2026-09-07 只读查询本机受管 `devspace.sqlite`：限定 run `run_f6c071568422400f88a81effd9cdfccd`、agent `agt_4b25dd32` / `agt_8ace198f`。SQLite 以 `readonly:true,fileMustExist:true` 打开，没有调用会迁移数据库的业务 store。仅提取状态、时间、计数、用量 delta 和响应长度；agentd 日志只筛选这两个 agent 的生命周期字段，没有读取 provider 私人聊天、命令正文、凭据或模型思维。

| 证据 | 本机实测 |
| --- | --- |
| 原 execution | `exec_4a6bf10bfb4c487186b2a7e7858c6307`，completed |
| 原 execution 起止（UTC） | 2026-09-06 15:39:02.897 → 16:54:24.848 |
| execution 墙钟时间 | 4,521,951 ms，即 75 分 21.951 秒 |
| agentd 完成日志 durationMs | 4,521,948 ms；与账本相差 3 ms |
| 独立审核排队 | 15:46:38.433 → 15:51:38.490，300,057 ms |
| 审核结果 | failed / AGENT_CONFLICT，requested=0、provider_finished=0、usage_quality=not_used |
| 原 run | running、acceptance=pending、receipt revision=226（读取时快照） |
| 主 agent 当前记录 | 已在后续执行中，running；latest_response 长度为空，不代表原 execution 未完成 |
| 原 run 的已记账操作 | 20 条：command 成功 2 / 失败 2；read 成功 6 / 失败 1；workspace_context 成功 7；inspection、scope 各成功 1 |
| 这些操作行的记录时间差合计 | command 成功 705 ms、失败 635 ms；read 成功 16 ms；workspace_context 17 ms；其余为 0 ms |

操作行的 created/finished 差是记账边界，**不是完整工具请求延迟**。没有该 run 的 observe/list_resources 请求级日志；诊断 JSONL 中这些 ID 的匹配条数为 0，不能据此说实际调用数为 0。主机给出的“88 分钟、一百多次 observe、数十次 list_resources、UI13984eb、840 test / 60 visual”是输入 trace 描述，本次未读取 yaxian 来独立复验。75 分钟执行与 5 分钟审核等待存在重叠，不能相加充当端到端耗时。

原 execution 的完整 delta：input 23,492,003（其中 cached input 23,140,736），output 73,403（其中 reasoning output 22,144），total **23,565,406**。只取这个 execution 的 delta 一次；不累加 receipt 快照，也不再次相加缓存/推理子项。`requested=1` 是一次受管执行已发请求的标志，不是 provider 内部模型请求次数；内部请求数和订阅扣费未知。

开始时核对了根 AGENTS.md，无相关嵌套 AGENTS.md；8 个预存 dirty/untracked 文件逐一记录 hash 并在提交前复核，未编辑或提交。给定四份输入中，AGENTS 与 presentation 的 CRLF hash 可从 HEAD 重建匹配；另外两份因初始混合行尾未保存逐字节副本，不能追认四份 byte hash 全部匹配。开始时 Git 确认这四份文件无语义工作区修改，实际实现以现场源码为准。

## 分层根因

1. **DevSpace 缺陷，有代码和回归证据。** observe 原 revision 包含 `record.updatedAt` 和整份 completion receipt。usage 触发 receipt revision 变化，即使任务仍 running，也令携带 knownRevision 的观察提前返回并重复传输完整 receipt。原 running 输出只有 id/status，主机无法判断在构建、等资源还是没有新活动。read 在 workspace resolve 后把 `~` 当成普通目录，绕过了本应识别 advertised skill 的失败分支；capture 则只支持源码相对路径。
2. **主机调度缺口，有受管终态但没有完整主机日志。** 原 execution 和 agentd 均完成，run 验收却仍 pending。主机应在终态取回结果、核对证据并显式结算或续接。不能让 provider completion 自动替主机作验收；本次没有替用户完成 yaxian 发布。
3. **MCP 外部发现回圈，归属证据不足。** `list_resources` 不等同于 agent_task observe，也不是 DevSpace 执行队列。现有本地账本没有该回圈的 caller/request 关联，无法断言每次来自主机还是 provider 的 MCP 客户端。本次没有全局禁用 MCP、重写发现 API 或修改 tunnel；精确归属需主控提供已脱敏的请求 trace。
4. **排队冲突是正确的互斥结果，但反馈不够可行动。** 审核等待独占写 claim，5 分钟后在模型调用之前失败。不能为了让审核“成功启动”而放松锁、抢 claim 或自动 replay 写入。

## 实际改动

- `agent_task observe` 分离 taskRevision / progressRevision，组合为兼容的 revision。用量、receiptRevision、updatedAt、elapsed/活动年龄都不参与 revision。保持 20 秒默认、25 秒上限和 500 ms 内部读取间隔，没有提高 timeout。每次读取仍先验证 workspace scope。
- 普通观察只返回有界控制信息；不再每轮构造、传输整份 receipt。终态即使 unchanged 也保留 responseAvailable、恢复说明与 nextAction。`includeResponse:true` 可以重复取得结果和完整 receipt，随后 nextAction 是主控 review_result，避免让主机机械地无限重取。完成和 acceptance 分离，绝不自动通过验收。
- 复用 Codex item started/completed 事件，经过固定词汇分类后进入现有 runtime callback/store。只保存单份 progress JSON：阶段、构建/测试/命令等类别、起始/准入/最后活动时间。相同类别的心跳最多每秒持久化一次；不保存命令、stdout、工具参数或思维。早于 turn/start 应答的活动使用最多 32 条脱敏缓冲，绑定 turn 后再发出；旧 turn 活动被丢弃。进度回调失败不能失败或重放已经发起的执行。
- migration 12 增加可空 progress 列。store 重开与 daemon record 解码均有回归证据；旧行未知值保持未知。已有中断恢复仍把 active 标为需要核对的失败状态，不自动恢复工作、不清 claim。恢复的是**最后观测证据**，不是保证进程仍在执行。
- busy continue/admission 冲突返回本次 requestAccepted=false、providerInvoked=false、owner scope、waiting 和 nextAction。只给同 workspace 可授权 owner 的 agentId；其他范围只给 claim 检查动作。queued observe 可取得过期时间、等待原因和最多 8 个 blocker 摘要，跨 workspace 不暴露 root、agentId、资源名或 PID。不改变 admission/queue 的写锁规则。
- read 入口先展开 home 路径，再按工作区或已加载技能 allowlist 决定 read roots；实际读取前检查 realpath。capture 使用同一解析，并保持文件大小、总行数、字节预算、二进制拒绝和 symlink escape 检查。外部技能返回阅读证据但不进入仅接受源码相对路径的 delegation refs。
- 仅对 start/continue 的缺字段错误增加 action、missingFields 和纠正提示；没有全局条件 schema/API 重写。

## 实测对比与回归

`src/test-support/execution-reliability-fixture.ts` 保存上述脱敏时间与 delta。120 次 usage 更新是**合成压力序列**，用于重放本次抖动机制，不冒充原 run 的原始事件数量。

| 同一 fixture | 改前机制 | 改后实测 |
| --- | --- | --- |
| 120 次累计 usage 更新导致 revision 变化 | 120 次 | 0 次 |
| usage-only 触发完整 receipt 附带 | 每次观察变化均附带 | 普通观察 0 份 |
| 120 ms longpoll，期间继续更新 usage | 下一次读取即认为有变化 | 最终定向运行 136 ms，2 次内部读取，unchanged |
| 构建事件 | running 无工具类别 | taskRevision 不变、progressRevision 改变，category=build |
| 主控连接关闭并新建 MCP server/client 后取回 | 依赖已有显式重取能力 | 同 revision 连续两次返回 terminal response；acceptance 仍 pending |
| queue/busy fixture | 缺少结构化下一动作 | nextAction / owner / admission 可核对，0 次 provider 调用，活跃 claim 未被释放 |
| secret / 有界性 | 无进展契约 | 大量合成 secret 被丢弃；持久化 progress <512 字符、观察 progress <1024 字符 |
| advertised `~/` 与绝对路径 | tilde read 会落入字面路径；capture 拒绝外部路径 | read/capture 各自返回等价结果；未 advertised、`..`、Windows junction escape 均拒绝 |

验证环境：Windows、Node 24.14.1；所有测试使用 fixture，不调用真实付费模型。

- 最终相关测试：**61 项，58 通过、0 失败、3 跳过**，44,541.7592 ms。3 个跳过是既有 Windows 平台跳过；新增 junction escape 测试实际执行并通过。
- 完整串行 `pnpm test` 执行一次：**194 项，185 通过、4 失败、5 跳过**，188,238.204 ms。其中本次新增 migration 使固定 migration 清单断言失败，已更新并在最终相关测试中通过；另外 3 个 workspace-conversation 测试在**纯 f3e4baa 独立 staging** 同样 0 通过 / 3 失败，首错均为 `Directory does not exist. Repeat open_workspace with createDirectory=true.`，没有改动它们。未把定向修复结果伪称为“全量全绿”。
- `pnpm typecheck` 及最终 `tsc --noEmit` 通过；`git diff --check` 通过。
- 从 HEAD 取运行必需文件、只叠加本次源码的隔离 staging：TypeScript build、Vite build、**1 个编译后 MCP smoke** 通过。smoke 检查 host 收到的 schema、终态重复取回和同目录 agentd 入口，providerInvocations=0。staging 不包含 8 个保护文件的未提交版本。
- 初次 fixture 因缺少 managed thread baseline 而收到未知用量，补齐 fixture 后通过；初次 queue fixture 清理顺序导致临时 SQLite EPERM，修正关闭顺序后通过。初次全仓库 tar 在已有中文图片文件名处报错，最终另建 runtime-only staging 成功；没有用损坏的初次 staging 作启用依据。

最终相关测试命令：

```powershell
pnpm exec tsx --test --test-concurrency=1 src/agent-task-tool.test.ts src/agent-progress.test.ts src/skill-read-contract.test.ts src/workspace-context-tool.test.ts src/local-agent-store.test.ts src/local-agent-daemon-protocol.test.ts src/local-agent-presentation.test.ts src/execution-coordinator.test.ts src/agent-admission.test.ts src/local-agent-manager.test.ts src/skills.test.ts src/workspaces.test.ts src/agent-usage.test.ts src/work-ledger.test.ts src/readonly-workflow.test.ts src/codex-usage-protocol.test.ts src/oauth-store.test.ts
node scripts/verify-execution-reliability.mjs releases/execution-reliability-20260907-runtime/dist
```

## 主控安全启用与建议接续

已验证的编译路径为 `D:\project\devspace\releases\execution-reliability-20260907-runtime\dist`。server 入口是该目录的 `cli.js serve`，它选取同目录的 `local-agent-daemon-main.js`。本次仅编译和无监听 MCP smoke，**没有执行 serve**。此 staging 为本机验证快照，node_modules 是指向当前依赖的 junction，不是独立可分发 npm 包。

主控在 yaxian 发布停稳后再决定启用：

1. 先用既有线上工具核对该发布的终态、process/agent 和 claims。若仍活跃或所有权不明，保持现状，不启动第二个同 stateDir server/agentd，也不按超时抢 claim。
2. 在所有受管工作明确停稳后，主控安排受控维护窗口、备份应用状态并选择一致的启动路径。源码 checkout 的 `node bin/devspace.js` 优先加载 src，`pnpm start` 则使用 dist；不要混淆。此提交不包含受保护的 server diagnostics/shutdown 未提交改动，启用时主控需决定它们的版本归属。
3. 如使用本次隔离编译路径，待主控安排旧 server/agentd 的安全替换后，候选命令是 `node D:\project\devspace\releases\execution-reliability-20260907-runtime\dist\cli.js serve`，使用用户原有受控配置；不修改 roots、凭据或 tunnel。新进程首次打开状态时才应用 migration 12。必须让 server 与 agentd 使用一致新版本；仅换 server 时旧 daemon 无活动事件，进度应显示未知，不能假称已启用完整能力。
4. 主控刷新工具元数据并在真实 MCP host 检查已授权 workspace 的 list/claims/observe 与终态 `includeResponse` 重取，再决定新任务。编译/内存 transport 成功不等于真实 ChatGPT 主控已加载 schema，也没有证明 GUI/项目注册成功。
5. 对原 run 先 `work_task get` 核对保存的 completion receipt。`agt_4b25dd32` 已复用于后续执行，观察必须对照 executionId；最新 agent 响应不提供任意旧 execution 的响应历史。主控应保存已取回结果，核对实际发布证据后显式 finish 或在对应 run 中继续相关任务。不要通过重复 start 复制任务，也不要将一个旧 completed execution 当作当前发布已经完成。

尚未解决：主机的外部发现回圈与终态后的调度选择、真实 88 分钟端到端效率收益、provider 内部请求明细、旧执行已覆盖的响应历史、真实服务替换/重启恢复，以及其他 provider 的细粒度活动。工具类别只是最近收到事件的提示，不能精确重建并行工具集合，也不证明构建成功。Desktop project partial 仍须按现有注册/权限契约处理；没有绕过或声称 GUI 成功。

## 恢复轮次的进一步核验

主控随后只读核验了恢复发布对应的精确 provider turn `01a0794f-a46a-7ca1-8680-59efff19fc04`，没有展示模型思维、凭据或私人记录。其开始为 2026-09-07 00:40:57.729 UTC，结束为 01:05:55.893 UTC，持续 1,498,159 ms；包含 64 个 `exec` 调用和 1 个异步输入请求。终态实际为 `usage_limit_exceeded`，并非没有执行工作。运行期间 DevSpace 回执没有获得可归属的新用量，旧版最终仅返回笼统的 `Codex agent turn failed`。

失败也不等于全部副作用没有发生。主控通过 Test 公网接口、发布回执和旧版模拟器截图独立核验：Android `2026090701` 在该 turn 结束前已完成发布。因此没有重放上传或再次推进 latest，而是从产物和设备状态继续验收。后续提供端额度未恢复时不再发起模型执行，确定性命令仍可继续完成任务。

本次新增错误摘要使用固定词汇区分额度/限流、认证、上下文、权限、模型配置和传输错误，支持实时 camelCase 与保存证据 snake_case 字段。不把提供端原文、URL、凭据或提示词放入错误摘要；额度、认证和权限错误不建议盲重试。传输错误的下一动作仍要求先核对原 turn 和已有副作用，而非直接重放。

另外修复 daemon 子进程继承父进程 Node `-e/-p/--input-type/--check/--test` 入口参数的问题，保留 loader/runtime 参数，防止嵌入式诊断重复执行父入口。此改动不修改已活跃进程，也不为诊断启动付费模型。

主控在上述最终源码上重新执行定向套件及 typecheck：**66 项，63 通过、0 失败、3 个既有平台跳过**，28,627.6527 ms。合成 120 次 usage 更新仍产生 0 次任务/进度 revision 变化；本次 longpoll 实测 127 ms、2 次内部读取。源码 `tsc --noEmit` 和 `git diff --check` 通过。此结果不覆盖或抹去前文全量套件的三个已复现基线失败；最终服务启用状态需另行记录。
