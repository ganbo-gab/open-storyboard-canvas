# 07 · ComfyUI 与外部 Agent 接入

## 1. ComfyUI

### 1.1 「昨天能用今天不行」的根因（#19，代码证据）

| # | 根因 | 位置 |
|---|---|---|
| 1 | 任何配置编辑都会改变配置指纹，待恢复任务因「供应商配置已变化」永久无法恢复——用户越重新配置越坏 | `customProviderGateway.ts:210-214, 5711-5717` |
| 2 | 连接测试只 ping `/system_stats` / `/queue`，工作流缺模型、缺节点、显存不足都显示「已连接」 | `comfyuiGateway.ts:571-582` |
| 3 | 基础地址粘成 `…:8188/prompt` 时 `/history`、`/view` 被拼成 `/prompt/history/…` → 404 | `providerUrl.ts:96-137` |
| 4 | 无协议头的非私网主机（局域网主机名、Tailscale 名）被强制 `https` → TLS 失败 | `providerUrl.ts:38-57` |
| 5 | 鉴权头只在 `apiKey` 非空时附加；隧道代理要求的头发不出去；Partner 节点需要的 `extra_data.api_key_comfy_org` 从不发送 | `customProviderGateway.ts:1884-1906` |
| 6 | 绑定（提示词/种子/尺寸/图片）用 JSON 文本框编辑，自动识别遇到多个候选就静默放弃 | `comfyuiGateway.ts:238-258` |

### 1.2 新设计

**连接**
- 地址输入框下实时显示解析后的三个地址：`/prompt`、`/history/{id}`、`/view`。粘贴带 API 路径的地址时自动剥离并提示。
- 协议头显式选择（http / https），默认按用户输入；不再猜测。
- 鉴权：无 / Bearer / 自定义头 / 查询参数，独立于 Key 是否为空；可选填 Comfy 账号 API Key（Partner 节点，提交时写入 `extra_data.api_key_comfy_org`）。

**工作流**
- 导入 API 格式 JSON（误导入画布格式时给出「在 ComfyUI 里用 导出(API)」的图示）。
- 绑定改为**节点选择器**：每个应用参数（提示词、反向提示词、种子、宽、高、时长、参考图 1..n、输出节点）一行，下拉列出工作流中所有匹配类型的「节点 · 输入」；每行显示状态「自动匹配 / 需选择 / 不使用」。
- 支持节点标题标记 `OSC:prompt`、`OSC:seed`、`OSC:image1`、`OSC:output`（兼容 ArcReel 的 `ARCREEL:*`），标记优先于自动识别。
- 一个渠道下可挂多个工作流，每个工作流就是一个「模型」，在节点模型选择器中按名称出现。

**检查（三级，结果逐项显示）**
1. 连通：`/system_stats`（显示 ComfyUI 版本、显卡、显存）。
2. 预检（免费）：拉 `/object_info`，核对工作流用到的每个节点类型都已安装、引用的模型文件存在；缺失项逐条列出。
3. 试跑（用户确认）：以最小尺寸/步数提交一次，显示耗时与结果缩略图；失败时指出出错节点与 ComfyUI 原文。

**任务**
- 提交时把「工作流快照 + 绑定 + 地址」写入任务记录；恢复与轮询只用快照，**编辑配置不再影响已提交任务**。
- 进度：优先 WebSocket `/ws?clientId=`（显示当前节点与采样步数），断开时退回 `/history` 轮询。
- 地址变化（ComfyUI 重启换端口、隧道换域名）后，「运行中」任务可一键「改用新地址继续查询」。

### 1.3 验收
- 用 issue #19 场景回归：保存 → 修改配置 → 旧任务仍可恢复。
- 粘贴 `http://host:8188/prompt`、`workstation:8188`、带头鉴权的隧道地址三种输入均解析正确（单元测试 + 预览快照）。
- 缺一个自定义节点的工作流在「预检」阶段报出节点名，而不是生成时失败。

## 2. 外部 Agent（Codex / Claude Code）

### 2.1 现状问题

| 问题 | 位置 |
|---|---|
| 用户需手动把 TOML/JSON 片段合并进 `~/.codex/config.toml` / `~/.claude.json` | `connection.rs:159-193` |
| 能力令牌 12 小时过期，第二天必须重建并重新合并配置 | `mod.rs:60` |
| 应用内看不到外部会话，只能看审批 | `ExternalAgentConnectionPanel.tsx` |
| 只暴露 4 个工具，所有画布操作挤在一个 `canvas_command` 里，外部模型难以发现能力 | `externalAgentToolManifest.ts` |
| 每次新建连接都轮换描述文件路径，CLI 配置里的旧路径失效 | `connection.rs:290-293` |

保留：自身二进制作 MCP stdio 服务 + 本机回环 broker + 能力令牌的安全架构；进程树管理与失败即关闭的监督逻辑。

### 2.2 新设计

- **一键接入**：检测到 Codex / Claude CLI 后，「接入」按钮直接写入对应配置文件（结构化合并，写前备份，界面显示 diff，可「撤销接入」）。
- **稳定描述文件**：描述文件路径固定（`<app-data>/mcp/osc.json`），令牌在应用每次启动时轮换并原地覆盖；CLI 配置写一次长期有效，不再有 12 小时断崖。应用未运行时 MCP 服务返回清晰错误「请先打开 Open Storyboard Canvas」。
- **工具清单与内置 Agent 一致**：直接导出 06 的工具注册表（按 surface 过滤），每个命令是独立 MCP 工具、独立 JSON Schema，风险等级映射为 MCP annotations（`readOnlyHint` / `destructiveHint`）。
- **会话镜像**：外部会话的消息与工具调用实时显示在应用 Agent 面板（只读镜像 + 审批），无需切窗口；也可在面板内直接给外部 Agent 发消息（Codex 走现有持久 RPC，Claude 走逐回合进程）。
- **状态诊断**：面板显示 CLI 已安装/已登录/已接入/最近一次调用时间；任一环节失败给出一键修复动作。

### 2.3 验收
- 新机器上：安装 Claude Code → 应用内点「接入」→ 在 CLI 中让它「在画布上建 3 个分镜节点」→ 应用内弹审批 → 节点出现；次日重启应用后无需重新接入。
- 撤销接入后 CLI 配置恢复原样（与备份逐字节一致）。
