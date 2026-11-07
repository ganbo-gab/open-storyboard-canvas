# 旧音频底层移除

2026-11-04，按用户明确要求移除豆包 local-doubao-tts、gradio-voxcpm 与独立音频模型设置，音频生成统一渠道。共享工作树保留，未修改 Git 索引、用户素材、服务或密钥。

## 实现

- 删除 `src/features/canvas/infrastructure/localAudioGateway.ts`、`src/features/canvas/application/audioInputSchema.ts`、`src/components/settings/AudioModelsSection.tsx`。未发现这些模块的通用消费者需要保留：音频文件读取/保存等通用媒体命令位于 `src/commands/image.ts` 和 Rust 媒体命令，均保留。
- `settingsStore.ts` 移除全部 AudioProviderKind / AudioModelConfig / AudioGenerationSettings 类型、旧默认供应商、音色目录、normalize 和 setter。设置版本升为 25；旧版本 migrate 与同版本 merge 均显式剔除 `audioGenerationSettings`，防止 spread 旧 persisted state 复活已删除设置。
- `audioGeneration.ts` 只保留文本/上游文本组装、渠道预览、稳定输入 hash 和渠道执行。移除自动 VoxCPM ASR，包括 payload preview 中曾经调用的转写副作用。画布音频执行统一 `channelAudioGeneration → submitChannelJob`；保留既有结果发布、原任务恢复与多输出行为。
- `AiAudioNode.tsx` 与 `AudioParams.tsx` 只展示渠道模型、声明模式、声明参数和素材槽位；模型管理去统一 providers 页面。旧的 voiceId/controlInstruction/usePromptText/promptTextValue 等节点历史字段未从项目数据中清除，但不再参与请求；用户显式选新渠道时仅保留新声明支持的参数/槽位。
- 旧 modelId 不会静默切换到另一个模型。画布明确提示不可用、预览/提交拒绝；Workbench validation 给 model.unavailable，transport 在解析媒体前拒绝非渠道音频模型。无 modelId 的新画布音频节点可采用首个可用渠道，和现有目录选择方式一致。
- 工作台 useCreationModels、transport、Home Agent generation_models 和 Agent 配置诊断统一使用 `buildChannelAudioModelCatalog`。修复无显式 modes 且第一 operation 是 chat 时，音频模型虽可执行但菜单 modes 为空的问题：音频目录提供对应隐式 audio 模式。
- 设置导出不再包含旧音频块；旧 bundle 导入先剔除废弃字段，再验证/应用其它配置，不把旧音频适配器自动改造成未经验证的 HTTP 渠道。

## 保留与迁移边界

已有音频素材节点、audioUrl/localAudioUrl、历史工作台结果、旧输入快照、素材导入导出和项目兼容字段均保留。旧 local 音频任务没有可靠原任务 ID，不能制造渠道任务 ID 或把旧配置猜成新付费请求。重做旧请求需要用户明确选择渠道。

`local-audio` 的历史迁移识别在 channelStore / legacyConfig 中仍有意义：它应被识别为旧非 HTTP 适配器，阻止错误迁移；主代理负责删除模板广场卡片及设置侧栏。旧基线散列文件记录被删除文件名属于历史证据，不改写。

文档需由主代理同步当前产品契约：`docs/rework/04-首页与工作台规格.md` 的“音频使用设置中已启用模型/generateAudio”、`docs/rework/08-实施与验收.md` 的“音频菜单同时列本地模型和 v2 渠道”已过时。过去验收证据应标注历史状态，不用改成从未发生过。

## 统一渠道音频能力核对

已存在真实声明和执行链：`audio.generate`、native audio catalog、模式/参数/参考槽位、模板 HTTP 提交、同步 JSON URL / base64 / data-url 输出、异步 taskId + polling、认证与原任务恢复、音频结果本地持久化、多输出音频/文本、工作台和画布发布。没有新增平行音频 runtime。

限制必须如实表述：当前 TemplateAdapter 将响应视为 JSON / 文本并按声明路径提取，未实现直接 `audio/mpeg` 二进制 HTTP 响应的音频专用分支；因此不能把所有标准 TTS API 宣称为直接填地址即可用。Gradio 事件流/文件上传、豆包本地 segmented 协议等旧行为按用户要求移除，未伪装为渠道模板。

## 验证

8 文件 129 个定向测试通过，覆盖设置同版/旧版恢复、旧 bundle 兼容、旧 ID 不换模型/不发请求、原音频结果节点保留、渠道真实预览/提交/多输出、混合 operation 音频目录、Home Agent 音频目录。日志 `/tmp/audio-removal-tests.log`。`git diff --check` 对拥有路径通过。

最后 TypeScript 检查在本切片范围无错误；当时共享工作树仍有主代理正在编辑的 SettingsDialog 未使用图标、ChannelSettingsPage 未使用图标，以及 ChannelModelEditor UiCheckbox `label` prop 错误，已告知主代理，未越权修改。日志 `/tmp/audio-removal-tsc.log`。无浏览器、无真实音频调用、无全量测试。
