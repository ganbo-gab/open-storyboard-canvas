# 原任务重新查询超时：诊断与修复

日期：2026-11-05。只读用户明确指定的原任务记录与脱敏日志；修改范围为渠道查询响应解析和生成恢复回归。没有读取钥匙串、没有访问供应商、没有重新提交生成、没有修改真实任务数据库或 Git 索引。

## 可核实的本地事实

只读打开 `~/Library/Application Support/com.ganbo-gab.open-storyboard-canvas/projects.db`，指定行：

- 本地任务：`custom-local-channel-job-145558b9-a0c8-4713-8dc5-dc2db17d6918`。
- 原上游任务：`12-89c6d6fb-55bb-440a-830a-9ff1850165ab`。
- 模型 `gpt-image-2`，渠道 host `grsai.dakka.com.cn`，操作 `image.edit`。
- 状态 `unknown`、阶段 `poll`、错误类别 `timeout`，`resumable=1`、`submit_attempts=1`。原任务编号仍在；快照没有 outputs/assets。
- 原查询合同为 `POST /v1/draw/result`，JSON `{ "id": "{{taskId}}" }`；状态字段 `data.status`，成功值仅 `succeeded`，失败值 `failed`；结果路径 `data.results[0].url`，2 秒间隔、2 分钟查询窗口。

检查 `~/Library/Logs/open-storyboard-canvas/storyboard.log.2026-11-05` 中该 host/path 的响应元数据，共 190 条 HTTP 200，没有匹配的 transport failed。响应长度分布：49 bytes × 170、259 bytes × 15、260 bytes × 4、373 bytes × 1。最后一条在 `2026-11-05T13:54:52.848633Z`（北京时间 21:54:52），与数据库最后查询时间吻合。

这些日志没有请求体、taskId 或响应正文，因此不能逐条证明全部属于这个任务，也不能由 49 bytes 推断具体业务错误码。它能证明这条查询通路曾成功收到 HTTP 响应，单纯“网络没连上”不足以解释现象。没有证据确认原图片现在仍可下载，不能宣称已找回原结果。

## 已修复的确定缺陷

1. **旧 GRSAI 快照成功条件过窄。** 通用解析器在声明 `success: ['succeeded']` 后，即使结果 URL 已出现，只要状态是 `success`、`completed`、`running` 或不存在，仍返回 pending。仓库既有 Rust GRSAI 适配器实际合同是先检查 `results[].url`；当前 GRSAI 预设也明确不虚构成功状态。这是可复现的不兼容。
2. **HTTP 200 业务错误被吞成等待。** 旧 Rust GRSAI 检查 `{code,msg,data}` 的非零 code，当前通用模板只看 `data.status`，因此 `{code:非0,msg:...,data:null}` 会空转到超时。
3. **查询诊断不足。** 通用接口缺少已配置状态字段、或查询抛出网络错误时没有可持久化的原因，用户最终只看到超时。

新增 `runtime/grsaiPollResponse.ts`，仅匹配现有 `grsai.dakka.com.cn`、图片操作、POST `/v1/draw/result`、既有 `results[…].url` 路径合同；不修改用户快照、请求体、凭据或任务 ID。支持裸任务对象及 `{code:0,data:...}` 包裹；结果 URL 出现即可完成，明确 failed 始终优先，运行中空结果继续等待。非零 code、无任务数据或非等待状态无结果会暂停成可恢复查询错误，显示固定解释和供应商 msg，由现有错误持久化路径脱敏。它们不证明原生成失败，因此保留原任务和恢复入口。

其他供应商继续使用声明的成功条件，即使同名路径也不套用 GRSAI 行为。通用缺少 statusPath 时只添加诊断并继续 pending，没有全局提前判失败。网络查询异常同样记录脱敏诊断，超时可呈现最后原因。

## 验证

```text
npx vitest run src/features/channels/runtime/grsaiPollResponse.test.ts src/features/channels/runtime/channelIntegration.test.ts src/features/channels/runtime/templateAdapter.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

最终三文件 89 项全部通过（GRSAI 专项 14 项），类型检查通过。

覆盖：旧 succeeded-only 快照遇到裸/包裹结果、running 中出现最终 URL、失败优先、HTTP 200 业务错误、缺 data、空运行态、其他 host 不受影响、通用状态字段缺失诊断。集成测试从持久化 unknown 快照恢复，只请求一次原 ID：成功分支下载原结果；业务错误分支成为 recoverable_wait，等待两分钟也没有后续自动请求，没有创建或重提任务。

测试中的 `code:-22`、响应正文及 URL 均为合成夹具，不是用户原查询响应。TS 原生命令是 mock；不等同于供应商实测。

## 原结果的下一步核实方式

运行包含修复的新包后，在原任务上选择“查询/取回结果”。若上游仍保留结果，兼容层可识别裸/包裹结果并取回；若返回业务错误，卡片会显示 code 和脱敏 msg，避免再把它伪装成两分钟等待。

如需供应商侧核实，用原渠道任务记录或 API 调试工具查询：

```text
POST https://grsai.dakka.com.cn/v1/draw/result
Authorization: Bearer <在用户自己的工具内填写，不粘贴到会话>
Content-Type: application/json

{"id":"12-89c6d6fb-55bb-440a-830a-9ff1850165ab"}
```

这是原任务查询，不是生成入口。核对 HTTP 状态、顶层 code/msg、data 是否存在、实际 status、results 数量。若向开发者提供诊断，只保留这些字段；删除 Authorization、API Key、提示词、参考图和结果 URL 的签名查询参数。若供应商显示原任务已过期/不存在，需要供应商的历史记录或原下载链接才能进一步找回；不能靠重新生成冒充恢复。
