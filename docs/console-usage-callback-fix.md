# Console 用量误报零与重复会话标签修复

日期：2026-09-06。代码基线：`97a7635`。问题样本为用户报告的工作运行短号 `7a6ace`。

## 根因与复现

真实执行路径为 LocalAgentManager → LocalAgentRuntimePool → CodexAppServerRuntime。
运行时池在包装 callbacks 时仅构造了 onSessionId，丢弃 onThreadInfo、onRequest、
onTurnStarted、onUsage、onProviderFinished、onNameResult。因此 provider 可以正常执行、
输出结果甚至完成会话命名，但调用开始、线程登记、Token 快照与完成事件没有进入账本。
已完成执行仍保留 requested=0、usage_quality=not_used 的初始值，旧汇总把它错误解释为零。

旧 JSON-RPC 验收直接调用 runtime.run，没有经过 RuntimePool，未覆盖丢事件的包装层。
本次先将该回归改为 pool.run，在修复前实测失败：预期 100，实际 0。补齐回调透传后
相同测试通过；还增加 manager.continue → pool → 真实 JSON-RPC 适配器的完整合成测试，
不手工代替 manager 的记账回调。所有 provider 响应均由本地假进程提供，不产生真实推理。

## 修改

- RuntimePool 透传完整 callback 对象，仅覆盖需要预留线程所有权的 onSessionId。
  新增生命周期回调不会因包装层逐项白名单遗漏而再次丢失。
- Manager 在进入 pool 前独立记录 provider_dispatch_unconfirmed。即使再次发生包装、
  进程或通知故障，未知的请求状态也不能被默认为“没有调用”。
- 汇总、详情、列表、项目统计使用同一 executionUsage 分类。已完成 Codex 执行缺少
  生命周期或用量时显示 unavailable/null，不显示 not_used/0；普通主控任务和确定在
  准入前取消的任务仍显示零。provider 实际报告的完整零用量与“没有收到事件”是两回事。
- 对历史异常行只在读取时纠正分类，不伪造 requested 事件、用量数值或历史创建证明。
  成功执行的终态也检查丢失生命周期的异常，并留下 missing_lifecycle_events 原因。
- 受管标题使用统一 formatter。项目名与 DevSpace 品牌大小写无关相同时省略重复项目
  标签；例如 `[DevSpace][devspace][7a6ace] 标题` 对应新规则 `[DevSpace][7a6ace] 标题`。
  其他项目保留 `[DevSpace][yaxian][短号]`。重复输入生成后的标题不会继续叠加标签。
  正文中的 DevSpace 不被删掉，恢复会话仍不覆盖用户后来手改的标题。

## 验证与数据边界

全仓回归 **156 项，153 通过、0 失败、3 跳过**。Pi 沙箱集成还在测试文件内部报告
环境依赖不足，不能算作已执行。类型检查和定向测试通过。定向测试包含真实 RPC 包装链、
完整 manager 路径、失败/迟到事件、两份用量账本、历史异常行的所有展示接口，
以及主控零用量和新标题去重。测试中的 100/400 等数字是合成数据，不是用户任务用量。

测试日志：`node_modules/.cache/devspace-console/usage-fix-tests.log`。

隔离 TypeScript 构建输出：`node_modules/.cache/devspace-usage-fix/dist`。编译后
JavaScript 实测历史异常分类为 unavailable/null，标题为单一品牌标签；未发起 provider
推理调用。当前服务使用的 dist 未被覆盖。

本次工作区对原代理的 agent_task usage 查询返回 WORKSPACE_MISMATCH。未删除或放宽
该作用域检查，也未以标题匹配为理由跨作用域回填或修改历史会话。确切旧用量仍需在
拥有该任务的授权作用域中，从对应 provider 用量证据核对后恢复，不能猜测或直接按
线程累计值回填。原任务还包含桌面 CLI 的验证步骤，不能把单个受管线程的数字冒充
全部验证成本。历史标题也未批量覆盖。

源码修复不等于运行服务已经加载新版本；需通过正常受控升级加载新运行时池和新
Console 汇总逻辑。既有 daemon 缓存的旧代码也需在没有活动任务后重新加载，不能
只刷新浏览器来修复事件丢失。

开始工作时存在独立的未提交项目命名/路径相关修改；这些修改保持原状，不纳入本次
修复提交。本次没有新建真实 Codex 推理任务，不修改原始 Codex 历史文件或凭据。
