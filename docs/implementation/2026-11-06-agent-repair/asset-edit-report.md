# 资产内容编辑与画布共用入口

2026-11-06。参考文档仅作为设计资料，没有执行其中的操作指令。

## 设计依据与本轮完成范围

阅读 AIGC `开发文档/01-产品需求总集.md` 的 K-01（资产表现形式、内在提示词可编辑）、D1-08/09（标注与旋转产生右接衍生）、F-06/07（视频剪辑、裁剪），并检查 video-maker 的 `src/features/editor/ImageEditor.tsx` 与 viewer 编辑入口。参考采用“打开原素材、在同一编辑器调整、保存新副本”的流程；使用 Storyboard 现有组件和本地处理器，没有移植另一个项目的后端/API。

- 资产库卡片新增“编辑内容”，媒体查看器动作中也提供入口。
- 图片：复用 CropToolEditor 的自由/比例裁剪、AnnotateToolEditor 的画笔/图形/箭头/文字与已有标注撤销；增加旋转 90°、水平/垂直翻转以及图片编辑步骤撤销/重做（最近 20 步）。保存会包含当前裁剪/标注，不要求用户先点一次应用；切换工具或旋转前也会先保留当前编辑。独立“应用”用于继续组合编辑。
- 文本：直接编辑正文、名称与素材提示词/说明，保存为新文本资产。
- 视频/音频：复用既有 MediaEditDialog 和本地媒体处理，支持原有截帧、时间裁剪、画面裁剪、音轨分离、音频切片/分割/变速。支持能力继续由既有编解码探测决定，不宣称平台不支持的编码一定可用。
- 画布图片节点新增“编辑图片”，使用同一个 AssetEditDialog。保存新资产后在原图右侧生成衍生节点和来源连线，一次图事务、一条撤销；原图和原节点不改。

本轮没有把 AI 蒙版重绘/擦除/抠图混入本地编辑。现有 MaskToolEditor 是 AI 编辑参数入口，后续需要明确模型、费用与既有审批；本地编辑入口不调用它，也不添加隐式供应商请求。video-maker 的马赛克、荧光笔等额外工具没有声称已经移植。

## 保存、来源与失败边界

`assetEditing.ts` 复用现有 `saveAsset`/媒体持久化：每个副本有新 assetId、独立内容源，禁止调用方用父 assetId 覆盖。记录 parentAssetId、来源项目/节点/任务、原名称、原元数据、操作列表及编辑时间；音视频保留输出的 sourceRange。新尺寸/时长来自实际结果，不继承原裁剪前的 width/height/resolution；原提示词留在来源记录，用户新说明写入副本。

保存前检查原素材仍存在、源未改变；画布还检查原项目和节点。保存途中切换项目时，已经持久化的新资产留在资产库，不插入另一项目。画布图事务失败也不覆盖原件。图片/文本索引保存失败会保留编辑器和错误状态，不报告成功；固定本轮结果 ID 避免重试制造另一条副本。音视频分割的多个输出逐个持久化，使用同一编辑会话的稳定 ID；中途失败可能已有部分副本，重试覆盖这些新副本而不影响父素材，不宣称跨文件原子事务。

UI 关闭前提示未保存编辑，操作中避免重复点击；组件退出后不发布迟到的图片处理结果。音视频沿用原有取消信号。本地中间图像可能进入已有媒体存储，但未保存时不会新增资产索引。

## 验证

```text
npx vitest run src/features/assets/application/assetEditing.test.ts src/features/assets/application/canvasAssetEditing.test.ts src/features/assets/application/assetCatalog.test.ts src/features/assets/application/assetMetadata.test.ts src/features/assets/ui/AssetEditDialog.test.tsx src/features/canvas/ui/MediaEditDialog.test.tsx src/features/canvas/application/media/media.test.ts src/features/canvas/application/media/mediaBoundaries.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

8 文件、63 项测试通过。新增测试覆盖真实资产索引保存/重开、原素材保留、来源与尺寸、存储失败、取消和 stale source；画布新节点/连线一次 undo、跨项目不插入；DOM 当前裁剪直接保存、说明编辑、工具切换不丢裁剪、保存失败保持编辑器；同一个视频编辑器使用资产源回调且不修改画布。既有媒体边界测试仍验证真实本地音视频夹具的切片与音轨内容。

最终全局 `tsc --noEmit` 通过，范围内 diff 空白检查通过。

主任务全量测试发现新增图片入口静态引用 Konva，会让纯 Node 环境的 nodeActions 消费测试尝试加载可选 native canvas。已复用 NodeToolDialog 原有按需分块：AssetEditDialog 使用 lazy/Suspense，仅进入标注工具才加载 Konva。这同时避免资产库/普通画布动作冷启动带入重型编辑器；没有添加 canvas 依赖或改变编辑产品语义。nodeActions 与 AssetEditDialog 两文件 7 项回归通过，随后全局类型检查通过。

没有真实供应商调用、真实用户项目编辑或浏览器视觉截图验收。图片 DOM 测试模拟底层裁剪/解码边界；实际像素绘制复用既有图片工具，本轮不能用这些测试冒称已经完成原生图片编辑视觉验收。没有修改 Agent codec、sdkRuntime、ScopedAgentPanel 或 WorkbenchComposer。
