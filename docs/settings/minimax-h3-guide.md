# MiniMax H3 视频生成 / Video generation

## 官方直连

1. 打开设置 → 添加供应商 → 视频生成，选择 **MiniMax H3**。
2. 填入 MiniMax 开放平台 API Key，保存。默认根地址为 `https://api.minimax.io`；这是国际站接口，请使用对应平台的账号与 Key。
3. 在画布视频生成节点选择新保存的供应商和 `MiniMax-H3`。默认 5 秒、768P、16:9；现有默认供应商不变。
4. 输入提示词。在参数菜单选择输入模式，连接所需素材后生成。

| 输入模式 | 需要的素材 | H3 请求角色 |
| --- | --- | --- |
| 参考 / 纯文本 | 可不连接素材；最多 9 图、3 视频、3 音频，总计不超过 12 | `reference_image` / `reference_video` / `reference_audio` |
| 首帧 | 1 张图片 | `first_frame` |
| 尾帧 | 1 张图片 | `last_frame` |
| 首尾帧 | 2 张图片，按节点参考图顺序，第一张为首帧、第二张为尾帧 | `first_frame` + `last_frame` |

提示词必填且不超过 7000 字符。帧模式不能混入参考视频或音频；输出比例由输入帧决定，请求统一使用 `adaptive`。纯文本生成不能选择 `adaptive`，须使用明确比例。参考模式支持 `adaptive` 或明确比例。

支持 4–15 秒的整数时长，分辨率为 `768P` / `2K`，比例为 `21:9`、`16:9`、`4:3`、`1:1`、`3:4`、`9:16` 或上述适用模式的 `adaptive`。本预设只包含 `MiniMax-H3`，不把限制不同的 `MiniMax-H3-Max` 混用。官方 V2 文档未声明的 watermark、音频生成开关等参数不会擅自发送。

## 素材要求

图片可经现有画布链路转换为 Base64 data URL，无需强制配置图床。参考视频和音频请使用供应商可访问的 HTTP(S) URL 或对应的 Base64 data URL；本地路径、`blob:` URL 不能直接发给远端服务。大素材建议使用公开 URL，完整请求体不得超过 64 MB。

官方限制：图片格式 JPG/JPEG/PNG/WEBP/HEIC/HEIF，单张不超过 30 MB，宽高 256–5760，宽高比 0.4–2.5。视频为 MP4/MOV（H.264/H.265，AAC/MP3 音轨），单段不超过 50 MB，单段 2–15 秒、总计不超过 15 秒，帧率 23.976–60。音频为 WAV/MP3，单段不超过 15 MB，单段 2–15 秒、总计不超过 15 秒。

应用在提交前检查模式、数量、时长、分辨率、比例、URL 类型与请求体总大小。远端 URL 的媒体时长、编码、尺寸及单文件大小由供应商验证；应用不会为探测这些信息而自动下载全部远端素材。

## 异步任务与恢复

应用仅发送一次 `POST /v2/video_generation`，将返回的 `task_id` 保存为本地任务记录。随后按 10 秒间隔使用 `GET /v2/query/video_generation/{task_id}` 查询 `queued` / `running` / `succeeded` / `failed` / `cancelled`。

成功结果只从 `task.content.url` 读取。轮询中断或应用重启后，使用任务面板安全取回已有任务；下载失败时可重新下载已有结果，不会重新创建付费生成。提交网络结果不明确且没有任务 ID 时，任务保持“状态未知”，不会自动重试。不要把手动重新生成当成取回，它可能再次计费。

MiniMax Key 用于官方 API；结果下载到其他域名时不转发该 Key。任务记录不保存 Key、提示词或参考素材。

## 通过 ComfyUI 使用 H3

见 [ComfyUI 接入说明](./comfyui-guide.md) 中的 H3 路线。当前 MiniMax 官方预设走云端。应用目前支持导入已在 ComfyUI 中运行成功的本地 H3 API 工作流。ComfyUI 官方另有云端 Partner API 节点，但本应用尚未实现其专用凭据注入，不能通过当前入口运行 Partner 模板；云端生成请使用 MiniMax 官方直连。本地路线需要完整的 H3 模型组件和满足要求的 GPU，不能用普通 SD 的 CheckpointLoader 模板加载。官方直连的 MiniMax Key、ComfyUI 服务器连接凭证以及 Partner API 节点凭证是不同配置，不会相互复制。

## 验证范围与官方来源

已用离线测试验证请求内容、参数边界、单次提交、任务恢复、终态解析和下载凭证隔离。没有使用真实账号发起付费视频生成；最终可用性受账号权限、余额和服务商状态影响。

- [Create a video task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [Query a video task](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)
- [ComfyUI local MiniMax H3 workflow](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)

## English quick start

In Settings → Add provider → Video generation, choose **MiniMax H3**, enter the API key for `platform.minimax.io`, and save. Select that provider and `MiniMax-H3` in a video node. Defaults are 5 seconds, 768P and 16:9; the existing default provider is unchanged.

A non-empty prompt of at most 7,000 characters is required. Choose Reference / text only, First frame, Last frame, or First + last frames in the node parameters. Frame modes require exactly one or two ordered images and cannot include reference video/audio. Their output ratio is adaptive. Text-only generation requires an explicit ratio. Reference mode supports up to 9 images, 3 videos, 3 audio clips, and 12 items in total. Duration must be an integer from 4 to 15; resolution is 768P or 2K.

Reference images are converted by the existing canvas media pipeline. Video/audio references must use accessible HTTP(S) URLs or matching Base64 data URLs. Local file paths and blob URLs are not remote API inputs. The composer validates modes, counts, duration, resolution, ratio, URL type and the 64 MB request limit; the provider validates remote media dimensions, codecs, duration and per-file limits.

Submission is performed once. The returned task ID is persisted, and recovery only queries that task or downloads an existing result. Ambiguous submission failures never trigger automatic paid retries. Provider credentials are omitted from cross-origin result downloads. The official MiniMax preset uses the cloud API. The app supports importing local H3 API workflows that already run successfully on your ComfyUI server. Comfy Partner API templates require a separate credential injection mechanism that this app does not yet support; use the official MiniMax provider for cloud generation. Local H3 needs the complete model components and suitable GPU hardware; a standard SD CheckpointLoader template cannot load it.

Verification used mocked HTTP and persistence only; no paid generation was performed. See the official API links above and the [ComfyUI guide](./comfyui-guide.md) for its separate route.
