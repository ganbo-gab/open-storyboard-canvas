# 有界跨层正确性复审：任务快照与 ComfyUI 多结果

日期：2026-11-04。项目 `/path/to/Storyboard-Copilot`。本轮仅源码/测试阅读；无业务文件修改、前端修改、全套测试、真实配置或付费调用。下述为确定静态链路，不冒充原生 GUI 实测。主代理另行运行隔离复现。

## 结论

主代理提出的两项均是真缺陷，未找到下游补偿；另确认聊天试跑快照遗漏清除 chatPayload，导致独立的 native 拒绝与浏览器正文持久化。建议前三项作为实际功能缺陷；Comfy 实时进度另列完整性缺项。

## 1. P1：Tauri 临时凭据提交与显式凭据恢复被 Rust 拒绝

### 证据链

- `src/features/channels/runtime/channelExecution.ts:293–295`：profile auth 非 none 且 credential 不是 opaque SecretRef token 时，构造根字段 `credentialSource: 'transient'`。该字段是非秘密来源标记，必须保留以防重启后误用配置中的旧 Key。
- `:299–301`：提交任何 HTTP 之前，先 `saveJob(..., true)` 保存该快照。
- `:59–65`：Tauri 分支将 pollDescriptor 原样传 `createGenerationJob` / `updateGenerationJob`，无字段过滤。
- `src/commands/ai.ts:303–318`：分别 invoke `create_generation_job` / `update_generation_job_record`，无补偿。
- `src-tauri/src/commands/ai.rs:1690–1693` / `1767–1769`：create 与 update 均走 `sanitize_job_poll_descriptor` → `sanitize_poll_descriptor`。
- `ai.rs:1437`：template 根白名单只有 version/adapter/profile/input/submit/assets/assetKinds/outputs/failure，没有 credentialSource；`:1441–1442` 对未知字段直接报 `v2 snapshot contains an unknown root field`。
- `channelExecution.ts:376–381`：recoverChannelJob 只要显式提供 credential（即使是合法 vault token），就构造 `credentialSource:'transient'` 并先保存；`:383` await prepared 之后才查询。故该恢复入口同样在 HTTP 前失败。

### 实际入口/影响

- `src/features/channels/application/channelService.ts:103–108` 的 `submitChannelSmoke(profile, input, credential)` 是临时试跑入口，会进入上述 submitChannelJob。
- 未保存渠道/本次临时输入 Key 的图片、视频、音频等生成试跑均可能直接失败，尚未产生上游计费。
- 已有原任务需要换 Key/显式重新绑定凭据时，桌面端无法继续查询或取回，仍不会自动重提。
- 默认保存 Key 是 SecretRef token 的普通提交没有这个根字段，不应扩大成“所有桌面生成都失败”。

### 修复方向

在 Rust v2 模板快照中允许且严格校验唯一值 `'transient'`，和 TS/Zod 契约一致。不要通过删掉来源标记绕过：那会重启后误用旧凭据。补真实 TS 构造快照→Rust validator 的契约测试，覆盖 create 与 recovery update。

## 2. P1：聊天试跑快照保留 chatPayload，桌面端全部被 schema 拒绝

这是与 credentialSource 独立的一项问题；使用正常保存的 SecretRef Key 也会触发。

### 证据链

- `channelService.ts:68–88`：generic chat smoke 将用户 prompt 适配为原生协议 payload，再调用 channelChatInput。
- `channelService.ts:154–156`：所有 OpenAI/Anthropic/Gemini 路径都返回 `chatPayload: record`，其中保留 messages 或 contents/input 等原始消息。
- `src/features/channels/runtime/types.ts:42–43` 对 chatPayload 明确标注 **Ephemeral provider-native chat fields**。
- `channelService.ts:103–108` 把上述 normalized job 传到 submitChannelJob。
- `channelExecution.ts:295` 构造恢复快照只覆盖 prompt:''、messages/tools/toolChoice:undefined、refs:[]，但通过 `...job` **保留了 chatPayload**。
- `ai.rs:1447–1453` 只允许 input 字段 jobId/channelId/modelId/modeId/operation/prompt/params/refs/count；chatPayload 未列入，立即拒绝 `v2 recovery input must not contain expanded prompts, messages, tools or media`。
- 浏览器 `channelExecution.ts:66–68` 没有 Rust 校验，直接 JSON.stringify(next) 落 localStorage，因此完整聊天试跑 prompt 在 chatPayload 中留存，清空 prompt/messages 没有真正达到快照最小化。

### 范围

- 确定影响 **渠道设置里的聊天试跑/冒烟**；无 auth 的 chat profile 也会受影响。
- 普通工作台聊天/Agent 的 `submitChannelChat` / `submitCustomChatCompletion` 使用即时 TemplateAdapter，不必经过 submitChannelJob；不能据此说所有 LLM 对话失效。
- 现 `channelSmoke.test.ts` 默认 browser，native create/update 为 mockResolvedValue，无法发现 Rust 不兼容；该测试只断言密钥未落盘，没有断言 prompt/chatPayload 不落盘。

### 修复方向

只保存恢复必要字段，不把 chatPayload 写入 snapshot；保留原 job 给首次 adapter.submit 发送。不能通过扩大 Rust input 白名单允许正文来修。对异步 chat 若模板依赖完整正文进行恢复，应有明确契约而不是偷偷持久化消息。

## 3. P1/P2：ComfyUI 下载整个批次，但公开结果和重开仅保留第一个

### 证据链与无补偿核对

- `src/features/channels/adapters/comfyui/adapter.ts:199–225` 遍历选定输出节点及文件，返回完整 outputs 数组；工作流 batch_size>1 或多个输出节点可自然产生多张图片/多个视频，和前端“发几次任务”无关。
- `src/features/channels/runtime/comfyExecution.ts:231–240` 保留所有输出 URL/kind。
- `:248–264` 实际下载并持久化每个 output，assets 数量可大于 1。
- **`:266–267` 成功 DTO 仅设置 `result:assets[0]`，没有 results 数组。** 完整 assets 只在内部 poll_descriptor。
- `:336–340` 公共 getComfyChannelJob 显式移除 poll_descriptor，消费者没有机会读到后续 assets。
- `:347–354` 重开浏览器仅取 descriptor.assets?.[0] 水合第一张；原生分支直接使用 Rust record，仍只有 result 字段。
- `src/features/canvas/infrastructure/providerGateway.ts:84/94/100/108` 实际 Comfy 提交/轮询/恢复直接转发上述 API，无附加资产恢复。
- `src/features/canvas/infrastructure/tauriAiGateway.ts:278–281` 继续透传 job，无补偿。
- `src/commands/ai.ts:42–46` 的 normalizeGenerationJobResults 在没有 results 时只返回单个 result，不能从内部快照恢复。
- `src/features/workbench/store/workbenchStore.ts:278–284` 同样优先 results，否则仅包装 result；因此工作台卡片/资产登记只获得一个结果。
- `src/features/canvas/application/generation/publishJobResults.ts:38–53` 根据 normalize 结果创建节点/批次；额外输出无法进入画布。
- Rust GenerationJobStatusDto/SQLite 更新只保存 `result`，通用模板执行器通过自己重建 `results`（channelExecution.ts:339–346）补偿；Comfy load 没有等价路径。

### 影响与优先级

- 两张实际生成/下载的图，只出现第一张；后续产物字节可能留在 IndexedDB/原生文件中，但正常公共 API、工作台、画布无法访问。刷新或恢复仍无法找回全批。
- 没有证据表明它再次收费，不能描述为“重试扣费”；是已生成结果遗漏与不可见存储占用。
- 若多图是主线承诺，P1；若仅把 Comfy 批量作为次要功能，P2。至少是确定功能缺陷。

### 修复方向

成功发布 results: assets.map((source,index)=>({kind: snapshot.outputs[index].kind,source}))；重开恢复全部 assets 与各自 kind；公共 DTO 保持快照脱敏但不能丢结果。使用一个上游 prompt 返回两个 distinct 文件的契约测试验证内存、持久化重开、工作台/画布消费者，确保 submit 始终一次。

## 4. 已确认完整性缺项（沿同链附记）：Comfy 实时节点/采样进度

- `comfyExecution.ts:164–189` dependencies 不注入 ws；所有生产 adapter 都用此函数。
- submit `:327` 与 poll `:270` 分别 create adapter，WS session 存于 adapter 闭包，即使单纯注入 ws 仍无法在 poll 读到 submit session。
- adapter.ts:185–186 可生成 pending.progress/message，但 runtime :284 只存 last_poll_at。
- 此能力有独立 adapter 测试，却没有生产通路；`docs/rework/07-ComfyUI与外部Agent接入.md:38` 和历史 BacklogMap I5 明确仍需完成。

## 验证建议（不重复主代理执行）

1. 从真实 TS 入口捕获 temporary image snapshot 与 vault-backed chat smoke snapshot，分别喂真实 Rust sanitize，保留确切错误。不能只做两端各自 mock 测试。
2. 单 prompt 的真实 localhost history 返回两条文件，再验证 Comfy public DTO 的 results 数、刷新后结果数；保持两条不同文件避免去重影响。
3. 当前审查没有运行补充测试；以上静态链路足够确定，运行证据由主代理补齐后在最终报告区别标注。
