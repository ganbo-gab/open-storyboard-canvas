# 渠道与历史结果可靠性修复

2026-11-04。本切片只改非视觉任务执行、边界类型、原生任务校验和对应测试。未改 UI、工作台 store、真实数据、供应商、CLI 配置、Keychain 或 Git 索引。

## 已完成

1. **临时凭据跨端契约**：Rust v2 template 快照现在严格允许 `credentialSource: 'transient'`，拒绝其他值，保留重开后不误用旧 Key 的来源语义。
2. **聊天正文不进入恢复快照**：TS 使用明确的恢复字段构建 input，不再展开整个 JobInput。首次聊天请求仍有完整 payload；读取旧浏览器快照后续保存也去除 chatPayload。
3. **ComfyUI 全部产物**：成功 DTO 和重开恢复均重建完整 `results`，顺序、source/kind 对应；旧已保存批次不用重新生成就能显露后续结果。浏览器持久化排除 process-local blob URL。
4. **ComfyUI 真实进度**：提交与轮询共用同一 adapter；无鉴权/query 模式且 system route 可连接真实 WebSocket，发布当前节点、采样步数、总步数和采样分数。新节点清零旧采样信息，忽略其他 prompt 的事件。断线/超时回退原任务 history；停止/结束/迟到连接会清理 socket。
5. **历史结果找回**：保留同步 template 的安全输出 URL。浏览器 IndexedDB 素材丢失时，普通读取诚实报缺失；显式 recover 通过已保存 URL 或原 task ID 取回，绝不重提。原生 `get_generation_job_record` 对已完成 v2 媒体路径检查真实 NotFound，以 `local_result_missing` 告知 TS；只有文件确实缺失且有原 task/output，Rust 才允许成功态进入查询/下载。禁止 submitting、禁止换 task ID，submit_attempts 不变。元数据列表不做批量文件 stat。
6. **结果最终一致性**：上游称 done 但暂无可识别产物、或结果句柄稍晚出现时，保留 recoverable_wait，后续 GET 能继续取回；真正的明确上游执行错误仍保持失败。
7. **历史记录隔离**：新增共享 Zod 浏览器记录边界，按 ID 验证目标记录。其他未知/损坏行保存时原样保留；顶层 JSON 损坏拒绝覆盖。无快照的旧单结果记录仍可读。

## UI 可消费的契约

`GenerationJobStatus` 新增可选字段：

- `progress`：0..1，代表当前采样器进度，不是编造的总任务进度。
- `current_node`、`step`、`total_steps`：真实 ComfyUI 事件。
- `progress_transport`：`websocket` 或 `polling`。无实际事件不显示假百分比。
- `local_result_missing`：原生确认本地文件 NotFound。TS 不用自行读原生路径。

实时进度只存在内存。Bearer/custom-header 鉴权和显式 direct/custom-proxy 不走 WebView WebSocket，因为 WebView 不能附加这些请求头或遵守指定 HTTP route；准确回退 `polling`，不会把 Header 密钥挪到 URL。原生 authenticated WebSocket 没有伪造支持或新加依赖。

普通结果读取失败后可提供“取回原结果”入口，调用现有 recover API。这个动作绝不能调用 submit/regenerate。旧 Comfy 批次 public results 修好后，消费者仍若把状态 succeeded 的旧工作台缓存当唯一来源，需要上层刷新任务 DTO 并更新结果清单；该 UI/store 收口由主代理处理。

## 验证

- 定向 7 文件 / **120 条 TS 测试通过**：channelSmoke、channelIntegration、comfyExecution、comfyLoopback、comfyProgressTransport、templateAdapter、Comfy adapter。
- `cargo test --lib commands::ai::tests`：**36 条通过**，含 transient 来源、chatPayload 拒绝、原生缺文件安全恢复临时路径测试。
- tsc 检查无错误（日志 `generation-tsc.log`）。
- 真实 localhost HTTP 回归：一次 POST、多张 PNG 下载、重开全量水合、丢失本地字节后再次 GET 找回，POST 始终一次。
- WebSocket 生命周期通过受控事件/异步连接回归，未连接用户真实 ComfyUI 或测真实 GPU 工作流。
- 未跑全套测试/build，交由主代理集成窗口统一执行。

## 文件归属

生产：`src-tauri/src/commands/ai.rs`、`src/commands/ai.ts`、`src/features/channels/runtime/{channelExecution,comfyExecution,templateAdapter,browserJobRecords,storedResult,comfyProgressTransport}.ts`、`src/features/channels/adapters/comfyui/adapter.ts`。

回归：`channelSmoke.test.ts`、`channelIntegration.test.ts`、`comfyExecution.test.ts`、`comfyLoopback.test.ts`、`comfyProgressTransport.test.ts`、Comfy `adapter.test.ts`、ai.rs 单测。

## 旧提交能否全部找回

不能承诺所有旧提交。只要原任务 ID、结果 URL 或本地素材仍在，本轮已补齐更多安全找回路径；但以下信息不足时不能凭空还原：提交后断网且从未收到 task ID、原任务记录被用户删除、同步 base64 结果未保存且没有远程 URL、供应商历史/签名 URL 已过期且无可查询 task ID。此时保留记录和原因，要求用户自行核对供应商，不自动再次收费。

没有批量访问或迁移用户真实历史数据，未把测试夹具结果当作所有真实旧任务均可恢复的证明。

## 底层评估

这里已经有 adapter→executor→persist 的基本层次，不能概括为不可救的整体结构。但确实存在边界维护债：TS/Rust 手写快照白名单各自更新、template/Comfy 两套执行器重复保存/恢复、浏览器持久记录与内存 Blob URL 混用，以及消费者另存任务结果后可能不刷新。此次收口了明确破坏行为的契约与共享浏览器读取边界，没有大拆通用执行器或制造第三套状态源。

后续最有价值的是固定跨语言快照契约测试、让工作台/画布统一消费任务 results，并将浏览器每次轮询全量 localStorage 序列化迁移到按任务的 IndexedDB。迁移必须单独验证旧数据兼容，不能为了代码整齐仓促替换现有持久层。
