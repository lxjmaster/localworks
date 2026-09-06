# 将 TaskQuay 接入 ChatGPT：服务器 URL 与官方 Tunnel

[中文首页](../README.md) · [English overview](../README.en.md) · [配置参考](configuration.md)

核对日期：**2026-09-06**。本教程面向你自己的 TaskQuay 实例，不使用其他作者的公共体验服务器，不要求把本地 owner 口令交给第三方。本次仅更新和校验文档，没有替读者创建隧道、变更账号权限或完成真实 OAuth 接入测试。

## 先分清三个概念

| 名称 | 这里具体指什么 |
| --- | --- |
| ChatGPT 插件／应用／连接器 | 在开发者模式中加入一个 MCP server；不同账号可能显示不同名称。 |
| GPT Actions | 自定义 GPT 导入 OpenAPI schema 的另一套接口。TaskQuay 当前没有对应的 `/openapi.json`，不能把 `/mcp` 当成 OpenAPI 导入。 |
| OpenAI Secure MCP Tunnel | `tunnel-client` 主动向 OpenAI 建立出站连接，转发私有 MCP 请求。不是 Codex Remote，也不是公开 HTTPS 反向代理的同义词。 |

平台权限、界面和网络策略会变化。本文涉及 ChatGPT 界面的步骤以[官方连接指南][connect]为依据；不要为了匹配旧截图而更改无关设置。

## 接入前准备

先按 [README 的源码安装](../README.md#从源码安装)完成安装。TaskQuay 应运行在能访问目标项目和相关工具的电脑或受控环境中。云服务器部署不会自动获得家里电脑的磁盘；需要远程访问家里的项目，就让入口正确转发到那台电脑，而不是仅将服务安装在另一台 VPS。

确认 Node、Git、pnpm 和所需 shell 可用。Codex 只在需要委派时另外安装和登录。配置的授权目录保持最小必要范围，不把整个系统盘作为快捷解决办法。服务目录的 `dist` 正在使用时不要重建；配置变更应在任务结束后受控重启。

在仓库根目录运行：

```sh
node bin/devspace.js doctor
node bin/devspace.js serve
```

另开终端查看本地存活状态：

```sh
curl --fail --show-error http://127.0.0.1:7676/healthz
```

Windows PowerShell 可用：

```powershell
Invoke-RestMethod http://127.0.0.1:7676/healthz
```

`/healthz` 返回成功只说明 HTTP 服务活着，不证明 OAuth、工具发现、Codex 或真实任务已经可用。未授权访问 `/mcp` 得到 401 可能正是鉴权在起作用，不要因此删除鉴权中间件。

## 在 ChatGPT 打开创建入口

先在桌面网页配置。按当前[开发者文档][developer]，从 **Settings → Security and login → Developer mode** 开启，再到 [ChatGPT Plugins](https://chatgpt.com/plugins)，点击 **+**。有些账号的入口仍为 **Settings → Apps → Advanced settings**；组织账号可能要先由管理员授权，然后在 Workspace settings 中创建。

开发者文档与[帮助中心][help]对部分套餐的开放范围描述不一致。实际能否创建、调用写工具、选 Tunnel，以账号页面、管理员策略与一次真实测试为准；不能只看套餐名字就认定“所有账号都可以”。没有入口时先核对权限，不安装绕过产品权限的扩展或共享他人凭据。

名称建议填 `TaskQuay`，描述可写“在授权项目中读取、修改、运行检查并返回任务回执”。接下来按下面两种方式择一配置。

<a id="server-url"></a>
## 方式 A：服务器 URL / 公网 HTTPS 入口

这是沿用 TaskQuay 内置 OAuth 的直接接法，适合已有域名、反向代理或用户自管 HTTPS 隧道的环境。

### A1. 建立完整的 HTTP 转发路径

```text
ChatGPT → https://taskquay.example.com/mcp
                       ↓ 受控 HTTPS 反向代理或隧道
              http://127.0.0.1:7676/mcp
                       ↓
                本机 TaskQuay 与项目
```

`taskquay.example.com` 是占位域名。转发目标是实际运行 TaskQuay 的机器；不要误指向代理服务器自己的 localhost。仅开放一个 TCP 端口也不等于已经配置了受信任 HTTPS。

本项目在 `/mcp` 外提供 OAuth 发现与授权。根路径转发是较少出错的起点；精细路由时至少检查：

| 路径 | 用途 |
| --- | --- |
| `/mcp` | MCP 初始化、列工具和调用。保留路径，不要被代理改写成 `/`。 |
| `/.well-known/*` | OAuth 服务和受保护资源元数据，以服务实际响应为准。 |
| `/register`、`/authorize`、`/token`、`/revoke` | 动态客户端注册、owner 授权、令牌交换／刷新及撤销。 |
| `/mcp-app-assets/*` | 启用工作区／变更卡片时所需的界面资源。 |

转发仍须保留所需的 Authorization 头和流式响应，不缓存包含授权或工具结果的响应，不把原始请求头写入公开日志。`/console/` 有自己的登录和远程开关，保持默认 local-only；不要用全局 Host 通配或无鉴权代理来解决单一路由问题。具体代理配置依据你选择的产品文档，本教程不在读者电脑上修改反向代理。

### A2. 配置 TaskQuay 的站点根地址

`publicBaseUrl` 是 OAuth 元数据等使用的**站点根地址，不带 `/mcp`**。在源码目录执行，将域名替换为自己的：

```sh
node bin/devspace.js config set publicBaseUrl https://taskquay.example.com
node bin/devspace.js serve
```

已有服务要先结束活动任务，再重启使新配置生效。临时 HTTPS 隧道换了地址，应同步更新这里和 ChatGPT 连接，必要时重新授权；不要把临时地址当永久服务承诺。

### A3. 创建 MCP 应用并完成 OAuth

| 表单字段 | TaskQuay 的填写方式 |
| --- | --- |
| Name / 名称 | `TaskQuay`。 |
| Connection / 连接 | Server URL / 服务器 URL。 |
| MCP Server URL | `https://taskquay.example.com/mcp`，这里需要 `/mcp`。 |
| Authentication / 身份验证 | OAuth。当前 TaskQuay 不是无鉴权 MCP server。 |
| 客户端注册 | 选择动态注册（DCR）或界面的自动注册选项。本项目的内置客户端存储支持 DCR；不要假定支持另一种注册方式。 |
| 固定 Client ID / Client Secret | 自动注册时不手填；owner 口令不是这两个字段。 |

创建后会进入 TaskQuay 的 owner 授权页面。核对发起客户端、scope 和资源地址，在自己的页面中输入初始化生成的口令，再返回 ChatGPT。口令保存在本机私有配置中；不要让模型读取该文件，也不要把口令粘贴到对话或 URL。

看到“已连接”后继续检查工具列表。只读初验应能访问 `open_workspace`、`read`、`workspace_context`；要记录任务回执还需要 `work_task`。这些能力的权限标签不同，平台仍可能提示确认。后续委派、修改和执行分别需要 `agent_task`、`apply_patch`、`exec_command` 等相应工具权限，不能仅凭一个只读工具成功就认定全流程可用。

<a id="official-tunnel"></a>
## 方式 B：OpenAI 官方 Secure MCP Tunnel

### B1. 先确认权限与两层认证

到 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建或选择隧道。由管理员分别授予创建／编辑所需的 **Tunnels Read + Manage**，以及运行／选择所需的 **Read + Use**。隧道必须关联实际使用的 Platform organization 与 ChatGPT workspace；ChatGPT 开发者模式权限不替代 Platform 隧道权限。[官方权限与关联说明][secure-tunnel]

| 值 | 用在哪 | 不应当用在哪 |
| --- | --- | --- |
| `tunnel_id` | ChatGPT Tunnel 选择、本机 tunnel-client 配置。 | 不是密码，也不是本机工作区 ID。 |
| Tunnel runtime API key | 本机客户端连接 OpenAI 隧道控制面。 | 不是 Codex 登录、TaskQuay owner 口令或 MCP access token。 |
| TaskQuay owner 口令 | 自己的 TaskQuay OAuth 授权页和管理台登录。 | 不填入隧道 API key、Client Secret 或 HTTP Bearer 字段。 |
| TaskQuay OAuth access token | OAuth 流程生成，由 MCP 客户端使用。 | 不手工用 owner 口令或 OpenAI key 冒充。 |

只使用有运行权限的 key，不把管理员 key 当日常运行凭据。创建隧道、运行隧道、调用模型是不同能力，不代表订阅附赠免费 API 推理。[官方入门文档][tunnel-onboarding]

### B2. 下载客户端并为 HTTP + OAuth/DCR 建配置

使用 [OpenAI 官方 Releases](https://github.com/openai/tunnel-client/releases/latest) 或 Platform 页面提供的下载，核对操作系统、架构与发布校验信息。不要从不明镜像下载带密钥访问能力的客户端。以下命令针对当前官方 CLI 语法，安装版本变化时先查看本机帮助：

```sh
tunnel-client help quickstart
```

TaskQuay 提供 HTTP `/mcp`，不是可直接用 `node bin/devspace.js serve` 充当 stdio MCP 的进程。建立 HTTP 绑定，选择官方 OAuth/DCR 样例 `sample_mcp_with_dcr`，不要套无鉴权样例。

**Windows PowerShell 示例**：在单独终端设置本轮环境；输入真实隧道 ID，不要把示例字符串当有效 ID。API key 用隐藏输入，不写入命令历史。

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = Read-Host "Tunnel ID"
$runtimeSecret = Read-Host "Tunnel runtime API key" -AsSecureString
$env:CONTROL_PLANE_API_KEY = ([System.Net.NetworkCredential]::new("", $runtimeSecret)).Password
Remove-Variable runtimeSecret

# 仅限本机 loopback HTTP。对跨主机或公网 MCP 必须使用 HTTPS。
$env:HARPOON_ALLOW_PLAINTEXT_HTTP = "true"

tunnel-client init --sample sample_mcp_with_dcr --profile taskquay --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID --mcp-server-url http://127.0.0.1:7676/mcp
tunnel-client doctor --profile taskquay --explain
tunnel-client run --profile taskquay

# run 结束后移除当前终端中的运行密钥。
Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
```

**Bash 示例**：使用 Bash，不是 CMD。下面同样只允许本机 loopback 的明文传输。

```bash
read -r -p "Tunnel ID: " CONTROL_PLANE_TUNNEL_ID
read -r -s -p "Tunnel runtime API key: " CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY
export HARPOON_ALLOW_PLAINTEXT_HTTP=true

tunnel-client init --sample sample_mcp_with_dcr --profile taskquay --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" --mcp-server-url http://127.0.0.1:7676/mcp
tunnel-client doctor --profile taskquay --explain
tunnel-client run --profile taskquay

unset CONTROL_PLANE_API_KEY
```

`HARPOON_ALLOW_PLAINTEXT_HTTP` 是官方客户端对本地 HTTP OAuth discovery 的显式选项，不是关闭 TaskQuay 鉴权、忽略 TLS 校验或允许公网明文密码。能提供本机可信 HTTPS 时优先使用 HTTPS 并不设置该变量。[官方 connector 说明][tunnel-connectors]

上述命令是部署模板，**doctor 失败时应停止并排查，不要继续视为成功**。配置中含实际隧道标识，环境中有运行凭据，均不要提交 Git、截图或导出到公共 Issue。

### B3. TaskQuay 特有的 OAuth 可达性不能省略

**官方隧道转发 MCP，并不自动把任意 OAuth 服务器路径都变成公网地址。** 官方支持发现与部分登记的 token／注册／撤销 shim 路径，但浏览器 `authorization_endpoint` 不会自动改写；未被 shim 处理的公开端点由实际 OAuth 调用方访问。[官方路由说明][tunnel-connectors]

TaskQuay 将 OAuth 与 MCP 放在同一个服务里，因此有两种需要认真区分的网络设计：

| 设计 | 是否可直接认为完成 |
| --- | --- |
| 隧道转发本机 `/mcp`，OAuth 仍使用自己控制的 HTTPS 根地址 | 需要让浏览器及相应调用方能访问授权页和必要端点，再实测完整流程。MCP 本身可以不公开。 |
| 所有服务都只在 localhost，认为 Tunnel 会自动转发 owner 授权页 | **不成立。** 手机浏览器的 localhost 是手机自己；云端 token 调用也不是你的电脑。需另行解决 OAuth 拓扑，否则使用方式 A。 |

混合部署时保留真实、可达的 TaskQuay `server.publicBaseUrl`，不要把它直接改成 OpenAI API 根域或整个 tunnel MCP URL。核对 authorization server 元数据与浏览器页面实际指向哪里；启用可选卡片时，`/mcp-app-assets/*` 也需有对应的资源访问路径。此处不声称 TaskQuay 已提供一个全私网 OAuth 代理。

隧道对外 MCP resource 可能与 TaskQuay 原资源标识不同。当前源码有 `oauth.resourceAliases` 精确别名支持。**只有在授权请求中核对实际资源值后**，将自己这个隧道的准确 URL 合并进现有私有配置；不要添加通配、他人隧道或猜测的域名。下面仅展示结构，不是可原样用于真实账号的配置：

```json
{
  "configVersion": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    "publicBaseUrl": "https://taskquay.example.com"
  },
  "oauth": {
    "resourceAliases": [
      "https://api.openai.com/v1/mcp/tunnel_REPLACE_WITH_ACTUAL_ID"
    ]
  }
}
```

这是**合并片段**，不要覆盖已有授权目录、provider、日志或 console 配置。资源别名只解决资源身份匹配，不授予访问权，不代替登录，不修复不可达的授权页面。对应实现是 `src/config-schema.ts` 与 `src/oauth-provider.ts`。

### B4. 在 ChatGPT 选择 Tunnel 并验证

保持 TaskQuay 和 `tunnel-client run` 都在线。在创建连接表单中选择 **Connection → Tunnel**，选择列表中的隧道或填入自己的完整 `tunnel_id`，继续 OAuth 授权和工具发现。runtime API key 不填入该表单。

隧道未出现在列表时，核对工作区关联、Platform organization 和使用权限。不要反复更换本机项目或关闭鉴权来修复账号关联问题。

官方客户端默认健康端口为 8080；以启动输出为准，端口冲突时按帮助配置单独的 loopback 监听：

```sh
curl --fail --show-error http://127.0.0.1:8080/healthz
curl --fail --show-error http://127.0.0.1:8080/readyz
```

`http://127.0.0.1:8080/ui` 是隧道客户端自己的诊断界面，`http://127.0.0.1:7676/console/` 才是 TaskQuay 任务台。`healthz`、`readyz` 或本地 doctor 通过，都不能单独证明云端权限、OAuth 以及工具调用成功；最后仍要完成下一节的真实小任务。[官方故障诊断][tunnel-troubleshooting]

官方 Tunnel 面向私有连接和开发者测试；公开插件目录提交仍要求稳定公网 HTTPS 端点。开源 TaskQuay 仓库不等于发布了可由公众访问你电脑的插件。[官方隧道指南][secure-tunnel]

## 首次验收与日常使用

在新网页对话的工具／插件菜单中选择 TaskQuay，或明确提及该应用。先用一个已获准的项目做分层检查：

| 步骤 | 验收依据 |
| --- | --- |
| 打开工作区、读取说明 | 工具确实执行，路径和内容正确，不只是模型说“已连接”。 |
| 建立并结束纯主控工作 | `work_task` 回执和 console 对应，不启动 Codex 的工作显示未调用。 |
| 明确授权一个小范围修改 | diff 正确，项目原测试不被无故改变，操作仍受权限和资源约束。 |
| 明确授权 Codex 委派 | 有受管任务和会话，来源正确，真实推理不能记成“未调用”。事件不全则显示未知。 |
| 验收后再尝试长任务 | 持续运行、重试与恢复有证据；不要用已发布生产系统做首次连通测试。 |

对话提示示例：

> 使用 TaskQuay 打开 `<已授权的项目绝对路径>`，建立本次工作记录。先由主控直接读取有关文件，不做全仓重复调查。需要实现时再委派 Codex，相关后续优先复用会话。完成适当测试后返回变更、验收范围和 Codex 用量回执。不要自行部署、公开推送、归档聊天或执行破坏性操作。

主控当前能用哪些记忆和历史由产品模式决定，TaskQuay 不会把所有长期记忆偷偷复制给 Codex。把必要约束明确写入任务或 AGENTS.md。减少重复确认靠任务边界和持续上下文，不靠关闭安全机制；[官方说明][developer]也明确写动作仍受确认设置约束。

手机是另一层适配：官方当前自定义 MCP FAQ 标注 web-only。先完成桌面网页验证，再检查你的手机浏览器能否实际选择与调用连接；不能把自定义 GPT Actions 在手机可用的经验推导成本项目的原生 App 支持。无需 Codex Remote，不等于无需可用的 MCP 客户端和网络。[帮助中心][help]

## 持续运行、更新与排错

主机、TaskQuay 和所选隧道／代理都应持续在线。首次接入使用前台可见进程，随后按你所用系统和客户端官方文档选择服务管理，确保可查状态、可停止、可重启。不要反复启动多份服务，也不要把 PID 存在或聊天已归档当作任务完成。

| 现象 | 优先检查 |
| --- | --- |
| 没有 Developer mode／创建／Tunnel 入口 | 账号和工作区权限、界面版本；不是本机文件路径问题。 |
| 创建时工具发现失败 | TaskQuay 进程、HTTPS 路由、隧道轮询、OAuth discovery；不要只检查 `/healthz`。 |
| OAuth 页面打不开 | `publicBaseUrl`、授权端点的调用方可达性；Tunnel 不自动代理浏览器授权页。 |
| 401／Invalid resource | 是否完成真实 OAuth、实际 resource 与精确别名是否匹配、access token 是否到期；owner 口令不是 Bearer token。 |
| 隧道 doctor 通过但远端 403 | runtime key 的 Read + Use、实际 tunnel ID 及 org/workspace 关联。 |
| URL 出现重复 `/mcp` 或 404 | 站点根地址与 MCP endpoint 分开填写，代理不剥掉原路径。 |
| 更新代码后工具不存在或 schema 报错 | 先确认服务运行的是新构建，再在连接详情 Refresh；组织发布版按管理员审核流程更新。 |
| 任务中断后不知道是否已写入／发布 | 先查工作记录、进程占用和远端回执；不以连接错误认定“没有执行”，不盲目重放。 |
| 手机能聊天但不能选 MCP | 检查实际客户端支持和消息级应用选择；聊天可用不等于该客户端具备开发者 MCP。 |

工具名称、描述、schema 或认证变化后，在 ChatGPT 连接详情执行 Refresh 并重新测试。必要时在新对话重新选择应用；公开已发布的连接可能需要管理员发布新的元数据快照。[官方刷新流程][connect]

## 从参考帖子借鉴了什么？

[yyjeqhc 的 webcodex 介绍](https://linux.do/t/topic/2544729) 展示了网页对话驱动本地工具、部署与授权分步骤说明的思路。本教程沿用这个易理解的组织方式，但为 TaskQuay 重新编写并使用自己的接口和官方资料。

没有迁移它的体验服务器、安装包、命令、授权 token、图片或 GPT Actions schema；也没有沿用“不消耗 Codex 额度”“不会封号”等跨项目保证。TaskQuay 主控直读不启动 Codex；真实委派会产生 Codex 消耗，账号与服务仍受各自条款约束。

## 资料与验证范围

本次核对了 TaskQuay 的配置 schema、OAuth provider、初始化及服务路由，并阅读以下官方资料。文档片段检查不等于创建了真实隧道或在所有账号、手机上完成实测；教程不假报后者。

- [OpenAI：ChatGPT Developer mode][developer]
- [OpenAI：连接与测试 MCP 插件][connect]
- [OpenAI Help Center：Developer mode 与移动端 FAQ][help]
- [OpenAI：Secure MCP Tunnel][secure-tunnel]
- [OpenAI tunnel-client：Onboarding][tunnel-onboarding]
- [OpenAI tunnel-client：Connector 与 OAuth 行为][tunnel-connectors]
- [OpenAI tunnel-client：Troubleshooting][tunnel-troubleshooting]

[developer]: https://developers.openai.com/api/docs/guides/developer-mode
[connect]: https://developers.openai.com/plugins/deploy/connect-chatgpt
[help]: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
[secure-tunnel]: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
[tunnel-onboarding]: https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md
[tunnel-connectors]: https://github.com/openai/tunnel-client/blob/master/docs/connectors.md
[tunnel-troubleshooting]: https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md
