# ComfyUI、MiniMax H3 与原五项任务审查

日期：2026-09-29。审查对象为当前分支有效代码（含既有未提交改动），不以之前模型的总结或任务勾选状态代替验收。

## 结论

**ComfyUI 接入值得保留，已有真实执行链路；之前的工作并非空壳，但视频参数与异常恢复没有完整收尾。** 本轮补上 MiniMax H3 官方直连及 ComfyUI 本地 H3 工作流入口，并修复发现的具体问题。尚不能声称任意云端服务或任意 NewAPI 版本均可直接使用。

如果用户只需要 H3 云端视频，官方直连更省配置。ComfyUI 的价值在于复用本地 GPU、模型与自定义工作流，以及把其结果接回画布；它不负责安装模型、插件或托管 GPU。

## 原五项任务完成情况

| 原任务 | 已有有效实现 | 本轮处理及剩余边界 |
| --- | --- | --- |
| ComfyUI 支持 | 独立设置页；API 工作流导入；参考图上传；单次提交；history 查询；view 下载；已有任务恢复 | 补齐视频参数/真实输入能力和本地 H3 入口；真实用户服务器仍需验收 |
| 导演台/预演台 | 路径、动作、镜头跟随、时间轴、角色与录制；指定会话记录了布局重做和录制计时修复 | 按本次要求保留既有改进，仅包含在全量回归中；未重新对标教程全部功能 |
| NewAPI/生图中转 | 文生图/图生图独立端点、JSON/multipart/form-urlencoded、图片字段单个/数组/重复、响应路径与轮询、脱敏预览 | 修复响应错误触发重发及错误分类；复杂图生图独立轮询仍可通过高级契约 JSON 配置，无万能自动协议识别 |
| Agent 功能与布局 | 对话/历史/任务导航、可调侧栏、审批记录、任务恢复、运行与项目隔离 | 本轮检查界面与已有测试，修复审批恢复错误仍允许无效自诊断的问题；未用真实模型跑完整对话 |
| Bug 与质量 | 先前已有持久化、媒体下载、路径/录制等修复 | 本轮有独立复现、修复及回归测试；测试通过不等于没有任何剩余 bug |

指定 JSONL 的可读内容主要是 9 月 28–29 日预演台改进，最后报告 590 项测试及当时的 macOS 包。其他功能的结论来自本轮源码、任务材料与 issue 核对，而非从该会话推定已完成。

## 本轮新增

### MiniMax 官方直连

设置 → 添加供应商 → 视频生成 → **MiniMax H3**，填入对应国际站 MiniMax Key。画布模型 ID 为 `MiniMax-H3`，默认 5 秒、768P、16:9；支持 4–15 秒、768P/2K，以及参考/纯文本、首帧、尾帧、首尾帧模式。模式、数量和参数在付费提交前校验。

使用官方 V2 content/role 协议，持久化 task_id 后只查询原任务；网络结果不明时不自动重复生成。跨域结果下载不转发 API Key。详见 [MiniMax H3 使用说明](../settings/minimax-h3-guide.md)。

### ComfyUI 本地 H3

设置 → ComfyUI → **MiniMax H3 本地视频**。导入已在自己的 ComfyUI 服务器运行成功的 API Format 工作流，自动识别 H3 提示词、画幅、帧数及采样种子。5–15 秒按 24fps、17k+5 帧网格对齐；宽高按本地 H3 的 32 对齐和像素上限验证。

这不是内置完整 H3 模型安装器。模型组件、GPU、采样、解码及保存节点由服务器工作流提供。**Comfy Partner H3 API 节点的凭据注入本轮未实现**；它和 MiniMax Key、ComfyUI 连接鉴权不是同一套凭据。详见 [ComfyUI 使用说明](../settings/comfyui-guide.md)。

## 主要修复

- ComfyUI 视频时长原先可选择但没有写入工作流；现支持时长、分辨率、比例绑定，未绑定显示“由工作流决定”。
- 视频参考能力原先无条件宣称支持九张图片和各种角色；现按实际工作流绑定派生，缺失必填图片在提交前拒绝。
- Advanced sampler 的 `noise_seed` 自动识别，以及 SaveVideo 在 history `images[]` 中返回 MP4 的真实输出形状有回归覆盖。
- 初次图片/视频成功和视频安全重取先等待关键数据库保存，再向 UI 发布成功；存储失败保留安全句柄，已确认终态不会被改回可恢复。
- 修复 Promise 清理链的未处理拒绝，以及终态任务仍被标为 resumable 的问题。
- HTTP 400 中描述上游响应/生成后结果失败的错误不再触发另一笔付费 POST；判断只读取上游详情，避免应用包装文案干扰。明确的请求验证兼容回退仍保留。
- 中文“响应解析失败”不再误报 DNS。
- 编辑图片契约第一个图片字段时保留其余字段。
- Agent 审批恢复遇到配额、限流或本地存储问题时，不再提供继续调用同一模型的自诊断入口。
- H3 设置隐藏专用协议不会采用的通用请求映射；ComfyUI H3 预览使用正确的视频参数。
- 视频节点不再静默截掉超过上限的参考素材；只配置视频供应商也不会再出现全局“未配置任何供应商”提示。

## 普通代理能否根治中转兼容

不能。普通代理解决网络路由、可达性等传输问题；`/images/generations` 和 `/images/edits`、JSON 和 multipart、`image` 和 `image[]`、URL 和 Base64、同步和异步响应，属于协议差异。

专门的协议转换代理可以集中维护适配，但仍需要逐种上游定义契约。当前更合理的方案是保留显式供应商配置、改善预览和诊断，遇到未知版本时用脱敏的真实请求/响应补适配，不靠不确定重发碰运气。

## 验证

- 前端：90 个测试文件、664 项测试通过。
- TypeScript 与生产 Vite build 通过；仍有既有大 chunk 和 Browserslist 数据陈旧提示，不影响构建成功。
- Rust：cargo check、cargo fmt --check 通过；cargo test 91 项通过。
- diff 空白与 LF 检查通过。
- Chromium 生产构建：H3 预设保存、画布模型选择、10秒/2K/首尾帧模式保存后刷新重开；ComfyUI H3 结构测试工作流导入、视频类型保存/编辑与预览；全局供应商提示；Agent 空状态导航。UI 工作流 fixture 仅用于配置验证，不是完整可生成模板。
- 新增请求、任务与恢复测试使用模拟 HTTP、数据库和媒体接口。**没有用真实 MiniMax 账号付费生成，也没有实际运行 GPU 上的 H3 工作流。**
- macOS 未签名测试包构建成功：`src-tauri/target/release/bundle/macos/Open Storyboard Canvas.app`。未进行 Windows 运行验收。
- 旧未提交预演台改动保留；本轮未提交 Git、未发布 release、未推送仓库。

## 一手依据

- [原 ComfyUI issue #19（明确提到 H3）](https://github.com/ganbo-gab/open-storyboard-canvas/issues/19)
- [生图端点 issue #7](https://github.com/ganbo-gab/open-storyboard-canvas/issues/7)
- [图片数组 issue #10](https://github.com/ganbo-gab/open-storyboard-canvas/issues/10)
- [MiniMax H3 创建任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [MiniMax H3 查询任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)
- [ComfyUI 本地 H3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
- [ComfyUI Partner H3](https://docs.comfy.org/tutorials/partner-nodes/minimax/minimax-h3)
