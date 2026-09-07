# Desktop 项目自动创建与线程归属核验

## 已接入的默认流程

`open_workspace` 完成显式目录准备后调用 `ensureDesktopProject`；Codex driver 在线程创建前和推理前再次使用相同入口。CLI 同样调用 `ensureSavedDesktopProject`，不再只有一次性手工修复入口。

1. 已存在的客户端项目直接复用；只读核对 `local-projects` 与对应 provider-home 的 app-server 映射。
2. 只有已授权、已存在的单一 Windows 本地目录确实缺少客户端项目时，发送 `codex://threads/new?path=<编码后的绝对路径>`。不带 prompt，不发送输入，不调用模型。
3. 最多等待 15 秒，只读确认客户端项目和服务端映射；启动命令成功不是验收证据。schema、歧义、不同 provider home 均拒绝自动变更。
4. 保留原线程标识，通过客户端映射对应的真实 projectId 进行归属更新和回读；不是只写 cwd 或改标题。
5. 未知/超时结果返回 partial，不自动推理、不重复创建源事件。已有多根项目保留全部根；缺失的新多根项目不拆成几个独立项目。

官方深链行为说明：[Commands — Deep links](https://developers.openai.com/codex/app/commands/)。本轮只验证安装中的 Windows 客户端与已核验 0.153.4 控制协议，不外推其他平台和版本。没有读取被工具拒绝的项目菜单，也没有修改全局 JSON、Codex SQLite、认证或信任配置。

## 实际新目录验证

纯控制验证目录：`D:\project\devspace\releases\desktop-auto-verification-20260907`，位于本工程已忽略的验证产物区；不是第二个 Voice Memory 业务项目。

执行 `pnpm exec tsx src/codex-project-cli.ts --root D:/project/devspace/releases/desktop-auto-verification-20260907 --create`，完成创建目录、发起客户端动作、独立客户端/服务端回读：

- `clientCreation=requested_and_verified`、`clientRegistration=verified`。
- 实际客户端项目 ID：`2b7d3552-5d27-4238-95fe-2580d3cff476`。
- 实际服务端映射 ID：`01a07a6a-4b0c-7621-8473-bc881cc29c08`。
- 回执：`C:\Users\wrfgup\.local\share\devspace\project-registration\d2ed3235-11a0-4a77-a6cd-2cabbb295c98.json`。

更早的手动单一深链验证目录 `desktop-project-verification-20260907` 也形成了真实客户端项目，但它仅用于发现可用客户端动作，不替代上述自动 CLI 验收。未自动删除这些验证项目或旧线程。

## 空线程验证的边界

`scripts/verify-desktop-project.ts` 只在明确的验证目录创建空线程，不发起推理。第一次未执行正式流程原有的命名步骤，元数据更新返回 -32603；该失败保留在回执。加入相同命名步骤后，空线程 `01a07a6f-e0d6-7482-a777-c062974e8f62` 的服务端归属更新和回读通过。

回执 `012ad0b6-9581-4af5-906a-42a43aa2b2c3.json` 同时如实记录 `clientAssignmentVerified=false`：客户端旧式 thread-project-assignments 尚未包含此无推理空线程。后来打开该空线程的深链并尝试跨连接 includeTurns 回读，返回 -32600。没有把这项失败改成成功，也没有通过发一轮无意义模型请求强行制造验收。正常受管创建流程本来就在归属更新前设置线程名称。

因此需要区分：**通用单目录客户端项目自动创建已实测通过，服务端线程归属已实测通过；无推理空线程的持久可见侧栏归属、窗口即时刷新仍未独立验收。**原 Voice Memory 的两个真实历史线程已有先前独立 UI 归属记录，没有为本次验证替换它们。

## 测试与部署

初轮新增深链/客户端目录/协议用例共 16 项，全部通过、0 跳过；TypeScript 类型检查通过。包括路径注入、无 prompt、旧项目复用、元数据暂未就绪、schema 拒绝、缺失多根目录与超时不能冒充成功。

随后在隔离空 CODEX_HOME 的完整测试运行中，75 个测试文件共 213 项：208 passed、0 failed、5 个既有平台 skipped；类型检查通过。真实客户端目录创建验证单独保留，不计入合成测试数量。完整收据 `2026-09-07T06-06-33-195Z-36383928-f3d9-47fe-82b4-8f5dc16f821a`，源指纹 `863451834dc06c4cff7e801d7feec2d7da0e44b62910f009b79bf58ebbddd900`。之后仅修正了实现注释和本段文档，不声称源哈希仍与后续文件字节相同。

本次增加的代码没有热覆盖运行中的 MCP/agentd，也没有重启仍在执行云端诊断的工作。源码集成、真实客户端控制、最终服务装载应分别保存验收结果。

最终源码提交 `bcf9fcc` 已包含默认路径与 CLI 的真实客户端自动创建。隔离候选位于 `D:\project\devspace\releases\voice-memory-final-20260907`，Vite 与 TypeScript 生产构建通过，409 个生成文件树哈希为 `6da2f1e86ce2924777362a8a03dfaa16fd28862110af1bd7f640c05f01acad2a`，明细见该目录 `build-manifest.json`。

本轮核对了当前 7676 监听：健康200，仍是此前启动的 dist/cli.js 进程。新增受限维护执行器的写入请求被工具安全检查拦截，未落地、未执行；没有换方式停止或替换该服务。因此客户端目录的真实自动创建已由源码 CLI 证明，但当前长驻 MCP/agentd 加载这一候选版本的验收仍未完成。后续正常安装/重启必须核对加载版本与 tools/list，不得仅用源码提交代替。
