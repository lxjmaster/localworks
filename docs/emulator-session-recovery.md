# Android 启动器遗留会话的受控回收

2026-09-06 实测 `android emulator start medium_phone --cold` 已报告启动成功，但后代模拟器持有输出管道，使原受管命令的 `close` 不触发。启动器结束后，对原 PID 执行取消不能证明后代已结束。

`src/emulator-session-recovery.ts` 是显式的兼容回收入口，不是另一个工作区绕过源码写锁：它只控制原命令已启动的模拟器，验证运行账本、原 workspace、唯一活动命令、原 claim、设备资源、SDK 路径、PID 创建时间、AVD 参数和实际 ADB serial/AVD。随后通过该模拟器的原生控制接口请求退出，复核进程退出；**绝不删除 claim 或手改运行状态**，原持有者应在管道关闭后自然完成并释放。

首次运行不带 `--apply` 只校验；确认作用于本任务进程才执行。缺少历史 PID/创建时间证据、另一个 AVD、PID 复用、源进程已失联或多个运行命令均拒绝。进程存在时不能据超时清锁。

新启动流程应使用明确的长驻服务模式，模拟器 stdio 重定向到自己的日志，并登记 PID/创建时间；短时启动命令返回后，再由独立有界的设备检查确认启动。长期服务不应无限占用项目源码写锁。此兼容入口不声称已实现所有命令的跨进程取消协议。

本次真实回收通过：原 VM run `run_602c1a972dcc4d5cb99317c3e5273af6`、原 claim `claim_c861adb42b6e4a98b0a699195bd8b809`、模拟器 PID 35208（创建时间 `2026-09-06T15:20:43.5195310Z`）与 `emulator-5554 / medium_phone` 匹配；dry-run 与 apply 均留有回执，进程退出已验证。随后原工作区 `agent_task claims` 返回空，未修改协调表。回执为 stateDir 下 `process-recovery/074fab3b-d091-4071-a8d0-0a9bb68cb0ea.json`。

重新启动使用 stdio 独立文件、明确关闭电脑麦克风的模拟器进程，短时启动操作退出码 0；安装和冷启动测试 APK 已通过。重定向方式不代表全局通用 service lease 已实现。

新增 3 个归属/PID 复用拒绝测试与 TypeScript typecheck 通过。第一次 dry-run 暴露 ADB 的 `CRCRLF` 输出，已按多重换行规范化后重新验证，不通过忽略设备身份来处理。
