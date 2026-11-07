# Agent 运行层修复验收（2026-11-05）

本次完成上传图片引用与 Anthropic Messages 工具参数流两项运行缺陷。未修改 UI/Composer，未操作 Git 索引、原有 1420 服务、真实凭据或付费供应商。

## 已修复

### 上传图片与历史会话

- 上传本身原先已通过 `saveAsset` 入库。缺陷是模型只收到不透明图片引用，没有真实 assetId/名称；旧恢复路径也只查画布目录，资产库上传图片在临时授权过期或重启后会被误判缺失。
- 新增 `agentSessionMedia.ts`，统一从既有资产库/画布目录校验附件并读取登记源。调用方传来的 source 不再成为读取权限；不存在的 ID、错误 nodeId 绑定会在模型请求前被拒绝。
- 真实 assetId、名称及当前 scope 可用读取工具放入隐藏的模型附件上下文，用户聊天正文不追加内部 ID；Stage 的画布附件使用完整 `project:<projectId>:<assetId>` 作为 asset_view 参数。
- 每轮执行、恢复中断回合以及重开 Scoped Agent 会话时，依据已持久化会话授权元数据恢复上传图片临时引用。必须同时匹配 referenceId、runId、assetId；仅凭一个任意不透明引用不能恢复全局资产。被移除资产保持 missing，并清除旧的临时授权。
- Canvas 的 asset_read 同样可读取用户从全局资产库明确引用的真实图片；继续经过既有审批和修订校验，不接受任意路径或 URL。
- 发送中 optimistic message 保留附件名称和预览，完成后替换为仓库投影。

### 前端集成 API

`AgentSessionMediaReferenceView.previewSource?: string` 是**仅内存视图字段**：

- 发送中取本轮附件 source。
- 已持久会话取恢复后的临时授权源。
- `ScopedAgentSession.loadSession()` 保持同步 API，完成异步恢复后通过 subscribe/publish 更新 messages；切换会话后不会把旧恢复结果覆盖到新会话。
- UI 可用 previewSource 渲染缩略图，必要时沿用 `getAssetDisplaySource`。该字段不属于 `AgentSessionMediaReference`，不得写入会话元数据或 RunState。服务传给 controller 的仍是原始 AgentTurnMediaInput。

### Anthropic Messages

- 标准 content_block_start 的 `input: {}` 是占位对象。第一次 input_json_delta 到来时开始新的 JSON 缓冲，不再得到 `{}{"…"}`。
- 按 content block index 独立累加并行工具；保留 JSON 字符串中的纯空白片段。
- 没有增量时保留完整起始 input，包括真正无参数的 `{}`。
- 完整 null/数组/字符串、损坏 JSON、截断参数继续拒绝，给出含工具名的中文“未执行”错误，不伪造 `{}`，不执行、不自动重提。
- 完整合法对象内的字段错误仍走既有工具 schema/受限纠错流程。JSON 本身已损坏时本轮明确停止，没有新加额外模型请求。

## 行为验证

命令：

```text
npx vitest run src/features/canvas/agent/application/agentSessionMedia.test.ts src/features/agents/application/scopedAgentSession.test.ts src/features/canvas/agent/infrastructure/agentModelGateway.test.ts src/features/canvas/agent/application/canvasAgentController.test.ts src/features/canvas/agent/application/agentMediaResolver.test.ts src/features/canvas/agent/infrastructure/sdkRuntime.test.ts src/features/agents/application/scopedAgentRuntime.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

结果：7 文件、73 测试通过；TypeScript 检查通过。包含真实 SDK 请求适配、真实内存隔离资产目录/会话仓库、Home/Stage 读取同一登记图片、上传 ID 元数据、丢失临时 grant 后恢复、资产删除后缺失、伪造引用拒绝、Stage 资产 ID 限定，以及 Anthropic 分片/多工具/无参数/无效输入和不重提验证。

## 验收边界

此处验证了实现、协议与状态行为。原生文件读取、真实 Anthropic 渠道请求和最终缩略图视觉验收由主任务实际走查；本次未进行任何付费调用，也未重打原生验收包。
