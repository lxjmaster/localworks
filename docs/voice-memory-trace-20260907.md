# Voice Memory trace：额度预检与长驻子进程句柄

日期：2026-09-07。此记录描述实际诊断与本轮补丁，不覆盖其他主控正在维护的历史记录。

## 已确认的调用失败原因

Voice Memory 新执行 `agt_e3b4a865` 与云端新执行 `agt_30a7ab91` 的 provider 终态错误经只读读取后归类为 `usage_or_rate_limit`，而不是编译失败或云端部署失败。检查仅输出错误分类和摘要指纹，没有输出聊天正文、思维内容或凭据。

随后 `account/rateLimits/read` 返回 `rateLimitReachedType=rate_limit_reached`；primary `usedPercent=100`、`windowDurationMins=10080`、`resetsAt=1788750852`，即当时返回的 2026-09-07 11:14:12（UTC+8）。`spendControlReached=false`。这是 provider 在查询时的额度元数据，不是本任务账单，也不能证明整个账户的消耗都由本任务造成。

本轮未消费任何 reset credit，未更换账户规避限制。查询不创建线程、不启动推理。失败执行的用量缺失保持 unavailable，不按零补记。

## 本轮新增能力

- `src/codex-quota-preflight.ts`：白名单化额度状态，丢弃无关/敏感字段。只在 provider 明确返回限制时阻断；不因一个窗口百分比达到 100 就推断所有模型/credits 都不可用。
- `src/inspect-codex-quota.ts`：独立、零推理的额度检查 CLI，只关闭自己创建的临时控制进程。
- `src/local-agent-codex.ts`：在项目登记、thread/start/resume 与 turn/start 前执行额度预检。明确限制返回 `quota_preflight`、不可立即重试及可操作状态，不再花费线程创建/项目操作后才失败。旧版本/API-key 模式不支持查询时保持 unknown，不伪造额度为零。
- 集成回归证明，额度已被明确限制时，项目登记回调未触发，线程创建/恢复和推理请求都没有发出。

本轮相关十项测试和 TypeScript 全工程类型检查通过。独立 CLI 已对实际安装的 Codex 0.153.4 运行成功；**没有把源码检查等同于正在运行的所有 daemon/MCP 实例已经加载补丁**。当前服务的升级/重启应在任务空闲且完成版本核对后进行，不中断其他主控任务。

既有 `cbd4baf` 已提供脱敏错误分类、可操作冲突归属及基于真实 progress 的 observe；本轮复用这些代码，不再实现第二套任务监管器。额度检查、排队、结果恢复本身均不需要 Codex 推理。

## Windows 长驻子进程的实际问题

Voice Memory 的 PostgreSQL 组合验证捕获输出时，pg_ctl 已经退出，但后台 postgres 继承的句柄使 PowerShell 持续等 EOF。只有该测试脚本的 PowerShell 与专用测试 PostgreSQL 存活，没有证据表明模型正在计算。

通过已记录工作目录、实例数据目录、PID、创建时间确认后，用该实例的 pg_ctl 优雅停止测试库，原命令正常回收；没有强行删除 execution claim，没有停止其他项目数据库。

修复位于 Voice Memory 的 `scripts/test-postgres-local.ps1`：启动器独立 stdout/stderr 文件，等待启动器进程而非长驻服务子树，45 秒有界退出；Go 测试 90 秒上限。真实 PostgreSQL 集成、停止/重启与撤回测试随后全部通过。与先前 emulator 管道问题属于同类生命周期约束，但不能把所有长驻服务一律当作僵尸终止。

## Desktop 项目能力的准确边界

Voice Memory 现有会话的 Desktop 可见项目归属已有前轮实际 UI 修复记录，见 `codex-project-registration.md`。app-server project 记录并不自动等同 Desktop 的 local-projects 目录。

当前适配器校验 Desktop client catalog，并对缺少客户端项目登记返回 partial。**通用无人值守的新建 Desktop 客户端项目尚未完成实际 UI 验收**；本轮只读 UIAutomation 未取得可操作窗口时没有改全局 JSON 或数据库制造成功。

## 仍需保留的失败信息

云端受保护配置写入及部分客户端仪器测试的工具请求被安全检查拦截，未执行，也未通过换路径/拆分/编码重试。不能将其标成 DevSpace provider bug，更不能将先前已经通过的 APK/原生测试/数据库验证一起清零。

## 额度恢复后的复验（2026-09-07）

用户确认恢复后，主控再次运行同一个只读额度接口：`blockedByProvider=false`、primary `usedPercent=0`、`resetCreditConsumed=false`。该结果只代表查询时状态，不推断后续额度恒定。

随后复用 Voice Memory 线程 `01a0798a-51eb-7d53-932e-5361ddbfd9b4` 和云部署线程 `01a0798c-2914-7c52-ab41-5ab9dfd316b6`，实际接纳且进入运行状态；没有为额度恢复新建替代线程。两个写任务各自拥有源目录与不同服务器资源，不在同一 checkout 并行写入。

额度、项目目录、原线程保留、错误分类、进度和结果恢复的针对性套件本轮为 31 项：28 通过、0 失败、3 个既有 Windows 平台跳过；TypeScript 类型检查通过。合成 120 次 usage 更新仍未改变任务/进度 revision。它不是本任务实际耗时或 Token 节省比例的测量。

尚须分别核验源码补丁的运行时启用，以及通用 Desktop 客户端自动项目创建。主控可调用工具的声明未暴露源码已有的 `createDirectory`，不能因此猜测所有组件都已更新。一次 Desktop 进程/安装元数据查询被工具安全检查拒绝，未重放或绕过该查询；其他开发与部署工作不因此被标成失败。

额度查询属于可选兼容性元数据；后续源码检查发现，使用通用 30 秒生命周期 RPC 超时，会让不响应此方法的旧 peer 每个 turn 多等 30 秒。现改为独立 5 秒上限；缺失元数据仍是 unknown，不改变显式额度耗尽时的阻断。合成沉默 peer 测试实测约 5.3 秒返回到原项目验证，未创建线程或发起推理；相关 7 项测试全部通过、无跳过，类型检查通过。协议 fixture 现在显式返回 method-not-found，而不是无回应；这不是线上完整部署耗时的 benchmark。

全量 `pnpm test` 命令的持久账本终态为 failed（`op_ed392a2587dc4fbfa39a0bc0e3016e32`）；完整输出读取受工具安全检查限制，未通过别的方式取回。已验证的定向结果不代替全量通过，也不推断未知失败的原因。
