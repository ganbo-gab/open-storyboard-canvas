# 07 · ComfyUI 与外部 Agent 接入

> 状态边界：用户最新暂停前端与本会话 Opus 调度；§1.1 / §2.1 是改进前问题，§1.2 / §2.2 和 §1.3 / §2.3 仍是未全部验收的交互目标。既有非视觉/原生契约和已写界面保留，不据此声称新 UI、真实 ComfyUI GPU、付费供应商、CLI 或原生平台验收完成。

## 1. ComfyUI

### 1.1 改进前「昨天能用今天不行」的根因（#19，历史代码证据）

| # | 根因 | 位置 |
|---|---|---|
| 1 | 任何配置编辑都会改变配置指纹，待恢复任务因「供应商配置已变化」永久无法恢复——用户越重新配置越坏 | `customProviderGateway.ts:210-214, 5711-5717` |
| 2 | 连接测试只 ping `/system_stats` / `/queue`，工作流缺模型、缺节点、显存不足都显示「已连接」 | `comfyuiGateway.ts:571-582` |
| 3 | 基础地址粘成 `…:8188/prompt` 时 `/history`、`/view` 被拼成 `/prompt/history/…` → 404 | `providerUrl.ts:96-137` |
| 4 | 无协议头的非私网主机（局域网主机名、Tailscale 名）被强制 `https` → TLS 失败 | `providerUrl.ts:38-57` |
| 5 | 鉴权头只在 `apiKey` 非空时附加；隧道代理要求的头发不出去；Partner 节点需要的 `extra_data.api_key_comfy_org` 从不发送 | `customProviderGateway.ts:1884-1906` |
| 6 | 绑定（提示词/种子/尺寸/图片）用 JSON 文本框编辑，自动识别遇到多个候选就静默放弃 | `comfyuiGateway.ts:238-258` |

### 1.2 目标交互设计（保留，非交付声明）

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

### 1.3 目标验收
- 用 issue #19 场景回归：保存 → 修改配置 → 旧任务仍可恢复。
- 粘贴 `http://host:8188/prompt`、`workstation:8188`、带头鉴权的隧道地址三种输入均解析正确（单元测试 + 预览快照）。
- 缺一个自定义节点的工作流在「预检」阶段报出节点名，而不是生成时失败。

### 1.4 当前 ComfyUI 应用与原生契约

#### 工作流集合与模型资格

- `src/features/channels/application/comfyWorkflows.ts` 定义唯一事实源 `CustomProviderConfig.comfyWorkflows: ComfyUIWorkflowCollection`：`{version: 1, selectedWorkflowId: string | null, workflows: [{id, name, mediaType: 'image' | 'video', config}]}`。ID 非空且集合内唯一；非空集合必须选中其中一个 ID，只有空集合可选 `null`。显示名可改，ID 保持稳定；`models` 投影为所有工作流 ID，不能按改名或数组序号重建模型标识。
- `useCustomProvidersStore` 提供 `addComfyWorkflow/updateComfyWorkflow/removeComfyWorkflow/selectComfyWorkflow`，同一连接的集合修改串行，调用参数与配置快照脱离调用方对象；重命名/修改保留其他工作流，删除当前选择后选首个剩余项，删除最后一项后为 `null`，无效/已删除选择显式报错。`readComfyUIWorkflows/resolveComfyUIWorkflow` 按 ID 读取；`withComfyUIWorkflows` 保存规范集合并移除旧 `extraParams.comfyui`，不维持两个可漂移版本。
- `normalizeComfyUIProvider` 只迁移 schema 与工作流图均有效的旧单工作流配置：保留首个已有 model ID（缺省才用 `workflow`）、工作流和绑定，生成 version 1 集合。损坏或不完整 legacy 原数据保留供显式修复，不能迁移成可执行的空工作流，也不能静默选择其他工作流。既有配置编辑/导入导出适配器保留整个集合；编辑当前项不丢失其余项。
- `buildImageModelCatalog` / `buildVideoModelCatalog` 分别按每个工作流的 `mediaType` 列出，标签取工作流 `name`，资格仍取决于已保存地址、所需凭据及工作流解析，集合中存在条目不等于可执行。`parseComfyUIConfig(provider, modelId?)` 校验对应工作流和输出节点；`getComfyUIReferenceRequirements` / `getComfyUIVideoCapabilities` 从有效 `bindings.images`（否则从 `LoadImage.image` 自动建议）计算多图容量及顺序要求，已有服务器文件名的槽位可不被画布图片替换。引用不满足 min/max 或绑定不存在时，在上传/付费提交前失败。视频工作流可用多张图片作为输入，但当前 Comfy 执行链拒绝视频/音频参考，不把「视频输出」误写成「视频输入」能力；通用非 H3 参数未绑定时保留 workflow 值，不虚构尺寸/时长能力。

#### 地址、鉴权与如实诊断

- `resolveComfyUIUrls` 保留反向代理前缀、剥离误粘贴的 API 路径并导出 `base/prompt/history/view/ws/objectInfo/systemStats/upload`，另返回 `defaultedScheme/strippedPath`。当前应用 API 对省略协议的地址补 `http://`，显式 http/https 原样遵循；§1.2 的显式协议控件仍是视觉设计，不应误写成现有 API 从不补协议。地址拒绝非 HTTP(S) 和用户名/密码，查询参数鉴权使用独立配置而非藏在 base URL。
- `resolveComfyUIProviderAuth` 保持已保存的 `none/bearer/header/query` 模式，空 Key 不改变模式；自定义请求头与查询参数独立存在。Partner Key 在提交边界注入 `extra_data.api_key_comfy_org`，不进入持久化工作流快照。凭据按 `SecretRef` / opaque token 保存，实际值由 transport 在请求前 JIT 解析；原生 transport 直接传引用由 Rust 解锁，浏览器适配器通过 `resolveSecretTokens/resolveSecretValue` 临时解析，不把明文回写 store/任务。`missing/locked/error` 必须可见；不能用空 token、旧内存 Key 或匿名模式绕过锁定。
- `src/features/channels/application/comfyConnection.ts` 的 `inspectComfyUIConnection(transport)` 仅 GET `/system_stats` 与 `/queue`，返回 `checkedAt/reachable/status/system?/queue?/errors`；状态为 `idle/queued/running/unknown/unreachable`。版本、设备名、显存等仅从有效上游字段提取；缺字段保持未知，不补零、不猜 GPU，队列只公开计数、不泄漏任务 payload。连通不等于模型齐全、工作流试跑成功或原生 GPU 已验证；该检查不发生成、不做 GPU 探测。

#### 原任务恢复、显式切换已保存连接

- `src/features/channels/runtime/comfyExecution.ts` 的 `submitComfyChannelJob` 在上传/提交前完成绑定预览和本地任务持久化，保存 version 2 执行快照与工作流、绑定、地址、鉴权结构（无凭据值）；返回本地任务 ID，接受上游 `external_task_id` 后先保存该 handle 再查询。编辑当前 provider 不改写原提交的 `input.params.comfyuiSnapshot`，不能靠配置指纹变化废弃已有任务。`getComfyChannelJobAsync/recoverComfyChannelJob` 仅加载、查询既有 `/history` 和下载结果，不执行 `/prompt`；无上游 prompt ID 的中断提交保留 `unknown`，不能伪装成安全重试或自动重发。
- `getComfyChannelRecoveryConnection(id)` 返回 `{originalBaseUrl, selectedBaseUrl, providerId, externalTaskId}`，为调用方提供原任务绑定；`switchComfyChannelJobRoute(id, {externalTaskId, originalBaseUrl, targetProviderId})` 只接受已确认上游 ID 的非终态原任务。目标必须是仍存在的已保存 ComfyUI provider，不接受任意临时 URL/凭据；校验原 prompt ID、原 base 与任务对应，拒绝 HTTPS → HTTP 降级。目标所引用的凭据不存在或 vault 锁定时阻断切换，不发送查询。
- 切换时先中止并等候原本地轮询/下载操作，再重新检查任务状态；仅增加独立 `recoveryRoute`，不修改原 job/channel/workflow/提交 base 或上游 ID。已有结果只允许重定向原连接的 `/view` handle，保留 `filename/subfolder/type`，拒绝其他来源/路径或无文件名的结果地址。新 route 和可恢复状态**持久化成功后**才重新查询/下载；存储失败不得先向新地址发送请求。跨源不携带旧凭据，恢复只读取所选连接的凭据。
- `comfySnapshot.ts` 与 Rust `commands/ai.rs` 对 `recoveryRoute` 严格白名单：`providerId/baseUrl/originalBaseUrl/externalTaskId/auth/authPrefix/headerNames/queryNames`；未知字段、类型错误、缺必填字段以及夹带凭据值的 auth 均拒绝。`auth` 仅含 `mode`，header/query 模式另含 `name`；这里只保存头/查询参数名称与前缀，不保存其秘密值。原生 admission/update 额外将快照的 job ID、原 channel/provider ID、原提交 base、已持久化的 `external_task_id` 绑定到同一任务，不能在切换中改绑或删掉已有 route 绑定。base 必须是无账号、查询串、fragment 的 HTTP(S) 地址；原生同时拒绝协议降级。错误与可恢复输出在存储/跨边界前继续执行 secret redaction，不因新增 route 放宽任意嵌套 auth 或秘密值的准入。

#### 结果水合与存储失败恢复

- 浏览器成功任务的本地素材保存于 IndexedDB `comfy-channel-assets-v2`，持久任务只记素材 key，不记跨会话失效的 blob URL。`load(id)` 对同任务合并并发加载（single-flight），成功记录先完成主要结果素材水合，再放入内存 `jobs` 缓存；读取失败不提前缓存一个不可用的 `succeeded` 结果。
- 水合所需的存储读取失败会清理本次加载占位并保留持久记录，修复存储后可再次调用 `getComfyChannelJobAsync` 加载；已有输出可由 `recoverComfyChannelJob` 重做下载/落盘。此类重试不重新提交、不再次发起付费生成请求；缺少已接受 handle 的未知提交也不会因存储修复被自动重发。原生查询继续复用已有 SQLite 任务，不因应用层恢复另造一次 submit。

## 2. 外部 Agent（Codex / Claude Code）

### 2.1 改进前问题

| 问题 | 位置 |
|---|---|
| 用户需手动把 TOML/JSON 片段合并进 `~/.codex/config.toml` / `~/.claude.json` | `connection.rs:159-193` |
| 能力令牌 12 小时过期，第二天必须重建并重新合并配置 | `mod.rs:60` |
| 应用内看不到外部会话，只能看审批 | `ExternalAgentConnectionPanel.tsx` |
| 只暴露 4 个工具，所有画布操作挤在一个 `canvas_command` 里，外部模型难以发现能力 | `externalAgentToolManifest.ts` |
| 每次新建连接都轮换描述文件路径，CLI 配置里的旧路径失效 | `connection.rs:290-293` |

保留：自身二进制作 MCP stdio 服务 + 本机回环 broker + 能力令牌的安全架构；进程树管理与失败即关闭的监督逻辑。

### 2.2 目标交互设计（保留，非交付声明）

- **一键接入**：检测到 Codex / Claude CLI 后，「接入」按钮直接写入对应配置文件（结构化合并，写前备份，界面显示 diff，可「撤销接入」）。
- **稳定描述文件**：描述文件路径固定（`<app-data>/mcp/osc.json`），令牌在应用每次启动时轮换并原地覆盖；CLI 配置写一次长期有效，不再有 12 小时断崖。应用未运行时 MCP 服务返回清晰错误「请先打开 Open Storyboard Canvas」。
- **工具清单与内置 Agent 一致**：直接导出 06 的工具注册表（按 surface 过滤），每个命令是独立 MCP 工具、独立 JSON Schema，风险等级映射为 MCP annotations（`readOnlyHint` / `destructiveHint`）。
- **会话镜像**：外部会话的消息与工具调用实时显示在应用 Agent 面板（只读镜像 + 审批），无需切窗口；也可在面板内直接给外部 Agent 发消息（Codex 走现有持久 RPC，Claude 走逐回合进程）。
- **状态诊断**：面板显示 CLI 已安装/已登录/已接入/最近一次调用时间；任一环节失败给出一键修复动作。

### 2.3 目标验收
- 新机器上：安装 Claude Code → 应用内点「接入」→ 在 CLI 中让它「在画布上建 3 个分镜节点」→ 应用内弹审批 → 节点出现；次日重启应用后无需重新接入。
- 撤销接入后 CLI 配置恢复原样（与备份逐字节一致）。

### 2.4 后端接入约定

- CLI 配置只引用 `<app-data>/mcp/osc.json`，不包含能力令牌。该文件以私有权限原子覆盖，保存用于重启恢复的项目与工具清单；启动恢复和显式重连均生成新的会话 ID 与令牌。撤销连接删除描述文件；连接信息的 `expiresAt` 为 `null`，不再表示墙钟截止时间。
- MCP stdio 在每次 broker 请求前重新读取描述文件；应用关闭或描述文件不存在时返回「请先打开 Open Storyboard Canvas」。broker 仍只监听 loopback，逐次验证会话与令牌，所有工具调用仍经过应用内审批。
- `external_agent_install`、`external_agent_uninstall`、`external_agent_install_status`、`external_agent_install_preview` 的参数均为 `{ cli: 'codex' | 'claude' }`。预览不写文件；实际变更前生成相邻 `.osc-backup-<timestamp>` 备份。撤销只移除 `storyboard_canvas`，未发生后续配置修改时恢复原始字节；存在后续修改时保留其他配置。
- 对外工具名称与注册的 CanvasCommand 类型一致，参数直接采用对应注册表的 `schema.input`。事件适配层将独立工具还原为内部 `canvas_command` 审批请求；`diagnostics`、`config_patch`、`asset_read` 保持独立。当前注册表未提供单独的 risk/surface 字段，annotations 保守按 effect 映射：read 为只读，graph/generation 标记 destructive，navigation 不标记 destructive。

### 2.5 本地媒体命令的取消边界

- 外部 Agent 工具仍沿既有审批、预算、revision/CAS、execute-once receipt 与原子画布/历史提交链执行，不因取消能力绕开授权。`resolveExternalAgentToolApproval({projectId, request, approve, signal?})` 将调用方信号经 `executeApprovedTool` 传给 `canvasCommandRegistry.executeApproved(..., {signal})`；本地媒体 decode/transform/encode 与提交前检查使用同一取消语义，不把失败输出写成成功节点。
- `useExternalAgentRuntime` 为每轮保留独立 `localExecutionController`；停止、丢弃会话或作用域清理时，先同步 abort 本地媒体执行，再等待 `cancelExternalAgentSession` 的原生响应，不让慢的 CLI 取消确认延迟本地停止；迟到的解码/编码结果不提交，并释放对应资源。此处描述既有接入链的非视觉行为，不新增停止按钮或宣称新的面板视觉已交付。
- 取消只约束本地工作与后续发布，不声称撤销已提交图变更、取消已接受的付费供应商任务或退款；停止本地等待也不能证明供应商未计费。未知的付费 submit 结果继续按原任务安全恢复规则处理，不自动重发。
