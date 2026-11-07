**落盘受限**：本侦察角色被要求严格只读，且工具清单没有写入工具，因此未创建 `local://frontend-backlog.md`。以下提供可直接保存的完整报告，末尾附 20 行摘要。未修改仓库，未运行构建、测试、lint 或服务器。

# frontend-backlog

## 判读规则与架构

- 下列路径均相对 Storyboard-Copilot 根目录。
- **missing**：没有找到对应可达 UI；已使用命令名及功能词两种方式检索。
- **partial**：UI 已有但缺少规格中的交互，或仍绕过已落地应用契约。
- **done**：源码中已存在并接线，**不表示本次进行了浏览器验收**。
- S/M/L 是 **[INFERENCE] 前端工作量**：单控件／单接线、多组件交互、跨视图状态／大型重构；不包含真实供应商能力开发。
- `task_plan.md:36-39` 的 N2-A/B/C/D 已交付非视觉能力；应复用这些能力，不重写第二套状态或持久化。
- 当前结构是：画布 UI → `canvasCommandRegistry`／现有 Store；舞台仍以画布 `BlueprintNodeData` 为唯一文档，`stageCommands` 提供事务、选择及捕获能力；人物、资产、素材、模板、历史使用 workspace document；知识库通过显式 vault 授权及原生 IO。
- 任务单历史差距 **不是当前完成状态**：以 `task_plan.md:52-64` 的 F1–F7 和实际调用方为准。

### 规格缩写

| 缩写 | 文件 |
|---|---|
| P | `task_plan.md` |
| D03 | `docs/rework/03-画布交互规格.md` |
| D04 | `docs/rework/04-首页与工作台规格.md` |
| D05 | `docs/rework/05-舞台规格.md` |
| D06 | `docs/rework/06-Agent规格.md` |
| D07 | `docs/rework/07-ComfyUI与外部Agent接入.md` |
| D08 | `docs/rework/08-实施与验收.md` |

## 一、画布

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| C1 标题栏 ⋯ 与右键使用同一菜单，包含全景预览、创建人物、重新上传、启用／禁用等；首次右键提示 | D03 §1、§4.2、§7；P:89 | `useNodeActions` 已有创建人物、重新上传、旋转、镜像、启禁用等：`src/features/canvas/overlays/nodeActions.tsx:185-224,288-324`；`node.setEnabled` 经共享注册表 | **partial**：`src/features/canvas/ui/NodeFrame.tsx:134-145` 没有通用 ⋯；右键独立实现于 `src/features/canvas/menus/CanvasContextMenu.tsx:98-177`，其条目与 `nodeActions` 不一致；工具条“更多”只显示溢出动作，见 `src/features/canvas/overlays/NodeToolbar.tsx:141-187`。不要只加一个不同菜单的 ⋯。 | M |
| C2 元数据标题显示「比例 · 分辨率」，悬停真实像素／模型等 | D03 §1、§4.2；P F4 | N2-A：`normalizeAssetMetadata`，`src/features/assets/application/assetMetadata.ts:33-66`；资产来源及尺寸字段已有 | **partial**：图片只传 `meta={aspectRatio}`，`src/features/canvas/nodes/ImageNode.tsx:139-150`；视频只显示时长或比例，`src/features/canvas/nodes/VideoNode.tsx:145-147`。尚未将规范化分辨率／像素事实呈现为规格标题与 tooltip。 | S |
| C3 生成百分比、0.1 秒计时、等待／未知／恢复状态 | D03 §4.2；P F4 | 任务状态投影 `CanvasGenerationStatusProjection`，`src/features/canvas/application/canvasGenerationFacade.ts:11-33`；已有 startedAt／预计耗时 | **partial**：计时器已有 100ms tick：`src/features/canvas/ui/NodeFrame.tsx:233-242`；`GenerationProgress` 只有按时间估计并封顶 96% 的无文字进度条：`src/features/canvas/ui/NodeGenerationFace.tsx:74-88`。通用状态投影没有数值进度字段，不能把时间估计冒充供应商真实百分比。 | S–M |
| C4 结构化失败分类、审核方向、明确的可重试说明 | D03 §4.2；P F4 | N2-B：`classifyGenerationFailure`，`src/features/canvas/application/generationErrorReport.ts:34-39,117-118`；状态返回 `failure`，`src/features/canvas/application/canvasGenerationFacade.ts:95-108` | **missing／partial**：结果失败界面仍只有通用失败标题与字符串：`src/features/canvas/ui/NodeGenerationFace.tsx:42-69`；图片调用方不读取 `generationFailure`，`src/features/canvas/nodes/ImageNode.tsx:78-88,181-188`。需要区分审核失败与普通错误；原任务恢复≠新付费重试。 | M |
| C5 多结果主图堆叠、结果条、设主结果、单项下载、拆为独立节点 | D03 §3、§4.2；P F4 | N2-B：`batch.setPrimary/setCollapsed/split`；拆分实现 `src/features/canvas/application/canvasCommandGraph.ts:773-805`；类型声明 `src/features/canvas/domain/canvasCommands.ts:165-168` | **partial**：图片已有上一项／下一项／展开收起：`src/features/canvas/ui/BatchStackControl.tsx:20-62`，挂在 `src/features/canvas/nodes/ImageNode.tsx:149`。没有结果缩略条、拆分入口；检索 UI 未找到 `batch.split` 调用；视频／音频未使用该 stack 控件。 | M |
| C6 文本富文本编辑、下载、复制 | D03 §4.1、§4.4；P:89 | N2-A：`prepareAssetDownload/downloadAsset` 支持字面 UTF-8 文本，`src/features/assets/application/assetDownloads.ts:13-30`；`collectDownloadableMedia`，`src/features/canvas/application/selectionAssets.ts:60-78` | **partial**：已有 Markdown 展示、textarea 编辑、复制和展开：`src/features/canvas/nodes/TextAnnotationNode.tsx:57-145`；不是可视富文本编辑器。文本单节点操作没有下载入口；多选下载已经正确区分文本，`src/features/canvas/overlays/SelectionToolbar.tsx:150-163`。 | M |
| C7 图片旋转／水平、垂直镜像 | D03 §4.3、§4.5；P:89 | `runNodeMediaEdit`／`image.transform`，`src/features/canvas/application/media/index.ts:86-145` | **done，待 UI 验收**：三动作直接调用真实处理层，`src/features/canvas/overlays/nodeActions.tsx:209-211`。不应重做编码链。 | S，验收 |
| C8 视频播放、截帧、剪辑、音视频分离 | D03 §4.5；P:89 | `video.captureFrame/trim/separateAudio`，统一处理／持久化／CAS 事务，`src/features/canvas/application/media/index.ts:28-42,86-145` | **done，待 UI／平台编解码验收**：节点播放器 `src/features/canvas/nodes/VideoNode.tsx:177-184`；工具入口 `src/features/canvas/overlays/nodeActions.tsx:249`；编辑器有播放、当前时间取值、分工具、进度、取消及错误：`src/features/canvas/ui/MediaEditDialog.tsx:65-110,139-177,206-224`；Host 已挂载 `src/features/canvas/Canvas.tsx:176`。 | M，验收 |
| C9 视频裁剪坐标契约修正 | D03 §4.5 | 处理层明确接受 **0–1 归一化 rect**，`src/features/canvas/application/media/types.ts:56-62` | **partial，确定性接线缺陷**：UI 默认把 `videoWidth/videoHeight` 直接放入 `rect.width/height`，`src/features/canvas/ui/MediaEditDialog.tsx:70-75`；输入步长为 1，`190-198` 附近。普通视频默认裁剪会违反 ≤1 校验。应转换像素到归一化，或全程采用归一化 UI。 | S |
| C10 音频倍速、切分、截取及参数范围 | D03 §4.5；P:89 | `audio.rate/split/slice`；倍速合法范围 0.5–2，`src/features/canvas/application/media/types.ts:65-70` | **partial**：音频编辑入口和三工具已有：`src/features/canvas/overlays/nodeActions.tsx:270-282`、`src/features/canvas/ui/MediaEditDialog.tsx:160-177`；但 UI 倍速允许 **0.25–4**，见 `:189-193`，与服务不符。切分输入、当前时间追加、取消／进度已有。 | S 修范围；M 验收 |
| C11 资产抽屉「画布树／资产」完整体验：按类、定位、树节点双击改名、资产拖回画布 | D03 §2、§3；P F4 | N2-A：`buildCanvasNodeTree`，`src/features/canvas/application/canvasNodeTree.ts:11-24`；目录、堆栈主项切换已有 | **partial**：已按类型建完整树，定位隐藏次结果先设主项，`src/features/canvas/panels/CanvasAssetPanel.tsx:51-53,88-100`；树叶只有单击定位，没有双击改名，`src/features/canvas/ui/AssetPanel.tsx:198-221`。媒体页仅当前画布图片／视频，音频被过滤：`src/features/canvas/panels/CanvasAssetPanel.tsx:22-28`；没有规格中的全局资产页签／拖回画布链路。 | M |
| C12 多选工具条：合并分镜、选区整体 ⊕ 连线 | D03 §4.4；P F4 | N2-B：`storyboard.merge`／`selection.connect`，`src/features/canvas/application/canvasCommandGraph.ts:992-1030,1280-1295`；输入 `src/features/canvas/domain/canvasCommands.ts:197-202,281-284` | **missing**：多选条没有合并分镜，也没有整体连线把手，`src/features/canvas/overlays/SelectionToolbar.tsx:176-240,250-269`。现有 ⌘L 仅支持两个节点按左右位置连线，`src/features/canvas/engine/canvasActions.tsx:169-180`，不能代替 fan-in。 | M |
| C13 多选工具条其余动作及 skill 入口 | D03 §4.4；P F4 | `saveNodesToAssets/collectDownloadableMedia`、`createSkillFromGroup`、模板保存及现有复制／分组／生成能力 | **partial**：排列三种、保存资产、复制、分组、下载、添加 Agent、知识收录、整组生成均已接；`src/features/canvas/overlays/SelectionToolbar.tsx:146-176,250-269`。创建 skill／存模板仅在单个 group 被选中时出现；普通多选没有直接 skill 流程。 | S–M |
| C14 添加菜单中的生成历史、全局资产、最近组模板 | D03 §7 | 已有资产库、历史库、`applyToolboxTemplateToProject`：`src/features/library/application/projectLibraryActions.ts:159-164`；库弹窗复用已有 | **partial**：添加菜单有搜索、节点、上传、特定输入的当前画布图片选择，`src/features/canvas/menus/AddNodeMenu.tsx:24-45,125-147`；未呈现生成历史／全局资产／最近组模板。工具栏库入口不等于添加菜单已完成。 | M |
| C15 不兼容连线禁止态＋原因、素材只做上游、整卡落点 | D03 §5、§11；P:82 | `explainConnection`／`edge.connect` 的共享规则 | **done，待交互验收**：拖动持续探测拒绝原因，`src/features/canvas/engine/useCanvasConnections.ts:46-81`；整卡释放处理 `:153-178`；禁止原因 chip `src/features/canvas/ui/NodeFrame.tsx:122-135,155-163`；素材 target 禁止手动连接 `:249-259`。历史差距已过时。 | S，验收 |
| C16 画布边界、小屏、输入与快捷键分层正式验收 | D03 §3、§4.3、§8、§11；P F7 | 已有 overlay placement、React Flow 视口、Store 同步、LOD／裁剪、快捷键服务 | **partial，主要是验收**：已有工具条避边与自适应动作溢出，`src/features/canvas/overlays/NodeToolbar.tsx:105-187`；鼠标／触控板、九种位置、小屏／长内容仍须按规格执行。不要重新把历史 fit-all 重压失败等同于当前正常视野日常目标失败。 | M |

## 二、舞台／预演

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| S1 对象真正隐藏／锁定，列表可重新选择／解锁，渲染与编辑尊重标记 | D05 §4.1、§6；P F5、N2-C | `resolveStageSelection`，`src/features/stage/application/stageSelection.ts:24-38`；`executeSelection`，`src/features/stage/application/stageCommands.ts:125-132`；严格锁保护 `src/features/stage/application/stageOperations.ts:18-19,183-186` | **missing**：Outliner 眼睛只切 `showLabel`，不是隐藏物体，`src/features/stage/ui/StageOutliner.tsx:101-102,159-166`。UI／renderer 检索未发现对象 `hidden/locked` 消费；直接 `onItemsChange` 编辑也未接锁保护。必须同时接控件、可见性和编辑边界，不只放两个图标。 | L |
| S2 Shift／⌘ 加减选、空地框选、批量隐藏／锁定／删除、中心 gizmo；时间轴／列表共享选择 | D05 §4.1；P F5 | N2-C 的瞬态选择 resolver＋批量原子操作，见上一行 | **missing**：Scene props 仍是 `selectedItemId: string|null`，`src/features/canvas/ui/BlueprintScene.tsx:201-204`；Outliner 同样单 ID，`src/features/stage/ui/StageOutliner.tsx:29-37`。空地 Shift 拖当前是平移，`:2259-2263`；没有多选集合与批量条。 | L |
| S3 双击对象聚焦／机位看向目标 | D05 §4.1 | Scene 已有聚焦、相机 snapshot／look-at 应用能力；`camera.lookAt`，`src/features/stage/application/stageOperations.ts:195-212` | **partial**：24px 近邻拾取已有，`src/features/canvas/ui/BlueprintScene.tsx:1957-1990`；但双击处理只结束绘制／给轨迹插点，`:2508-2528`，没有规格中的双击对象聚焦。 | S–M |
| S4 gizmo Δ 距离／角度、⌘ 0.5m／15° 吸附、Y 贴地／Shift 解锁、人物 Y-only 旋转 | D05 §4.2 | Three `TransformControls`，变换释放时一次写回，`src/features/canvas/ui/BlueprintScene.tsx:1642-1714` | **partial**：G/R/T 与 single-object gizmo 已有；模式配置仅 `setMode/setSpace/setSize/attach`，`:1716-1749`。未发现 translation／rotation snap、Δ 提示、人物轴限制／临时解锁。保留现有手势结束提交，不换渲染框架。 | M |
| S5 相机 target／point／free 三态，以及视线虚线、可拖端点、R 转 free | D05 §4.3；P:83 | `camera.lookAt` schema `src/features/stage/domain/stageSchemas.ts:34,44`；渲染已优先 freeRotation `src/features/canvas/ui/BlueprintScene.tsx:2964-2969` | **partial**：三态属性控件已存在，`src/features/canvas/ui/DirectorMotionInspector.tsx:335-416`；还没有对应场景端点／视线反馈与 R→free 的完整手势。不能把三态 UI 再列为全缺。 | M |
| S6 自由画／逐点／直线后的正确应用：≤20 点、人物默认走路、仅替换指定区间 | D05 §4.4、§6 | `trajectory.set`，`src/features/stage/application/stageOperations.ts:214-251`；Douglas–Peucker `src/features/stage/domain/stageTrajectories.ts:10-29`；`replaceStageTrackRange`，`src/features/stage/application/stageRanges.ts:18-48` | **partial，接线有语义落差**：三种绘制与编号、虚线、直线长度已有，`src/features/canvas/ui/BlueprintScene.tsx:1522-1590,2668-2698`；但 UI 完成后仍走旧 hook，自定四秒并删除开始时间之后旧轨迹，`src/features/canvas/ui/useDirectorStudioMotion.ts:474-505`，没有复用 N2-C 的区间保护／人物走路契约。 | M |
| S7 路径时长胶囊拖动、闭合开关、空间子轨展开与路径编辑反馈 | D05 §4.4 | V1 路径关键帧、轨迹增删改、retime 已有；`src/features/canvas/ui/useDirectorStudioMotion.ts:519-584` | **partial**：已有点拖动、双击插点和状态提示；没有查到路径旁可拖时长胶囊／起点闭合控件。数据仍是 V1 keyframe 路径，不应假设已存在独立 trajectory/clip V2 文档。 | M |
| S8 时间轴吸附 0.1s／相邻边界／播放头、片段最小 0.2s、拖动时间反馈 | D05 §4.5 | 现有 retime、播放头与轨道求值 | **partial**：拖动反馈／剪边已有，`src/features/canvas/ui/DirectorTimeline.tsx:310-356,737-747`；实际吸附仅到 **24fps 帧**，`:272-273`；边缘最小值 **0.1s**，`:326-330,447-451`，与规格不符。没有邻边／播放头吸附。 | M |
| S9 S 分割、片段 ⌘拖复制、重叠优先级／置顶 | D05 §4.5、§6；P N2-C | `clip.split` 已实现，`src/features/stage/application/stageOperations.ts:261-264`；`splitDirectorMotionClip`，`src/features/canvas/application/directorMotion.ts:1004` | **partial／missing**：UI 有关键帧 ⌘拖复制，不是片段复制；时间轴按键无 S，`src/features/canvas/ui/DirectorTimeline.tsx:540-565`。**优先级只找到既有“最新开始／同起点后项优先”求值**，`src/features/canvas/application/directorMotion.ts:643-648`，没有显式 bring-front／priority 命令；不能将“置顶”全部当已有 API 纯接线。 | L |
| S10 缩短总时长时提示并拒绝静默截断 | D05 §4.5；P N2-C | `playback.update` 已检查有效末尾，`src/features/stage/application/stageOperations.ts:49-60,269-272` | **partial，确定性契约绕过**：UI `updateMotionDuration` 仍把全部 keyframe 时间压到新末尾，`src/features/canvas/ui/useDirectorStudioMotion.ts:413-424`；调用位置 `src/features/canvas/ui/DirectorStudioShell.tsx:3235`。应接应用命令并呈现拒绝原因。 | S–M |
| S11 K／I、关键帧框选统一看向、hold 缓动、帧步进 | D05 §4.6；P:83 | 现有 keyframe update／批量 patch／运动求值 | **done，待浏览器验收**：框选／多选及菜单 `src/features/canvas/ui/DirectorTimeline.tsx:71-75,143-205,285-303`；K/I、删除、单帧／十帧 `:540-565`；三种 easing 已有。 | M，验收 |
| S12 四视角截图／精确时间输入、结果预览与送回画布 | D05 §2.5、§7、§9；P F5 | N2-C：`stageCommands.capture/captureFourViews`，`src/features/stage/application/stageCommands.ts:147-180`；真实离屏桥已挂载 `src/features/canvas/ui/DirectorStudioShell.tsx:2667-2728` | **missing**：没有四视角／指定时刻控件。现有截图按钮仍调用旧 `exportPng`→snapshotHistory，`:2170-2192,2997,3309`。应用桥已具备同步／取消／四图原子结果，不能用四次随手截图替代。 | M |
| S13 机位画中画、相对跟随／特写参数实时反馈、首次三步引导 | D05 §2、§4.5；P:83 | 现有 camera rigs、采样与预览 draft | **done，待完整验收**：跟随／特写、距离／高度／角度／FOV／阻尼及预览/释放提交，`src/features/canvas/ui/DirectorCameraRigPanel.tsx:19-82,85-175`；PIP renderer `src/features/canvas/ui/BlueprintScene.tsx:2740-2759`；引导挂载 `src/features/canvas/ui/DirectorStudioShell.tsx:3156-3181`。 | M，验收 |
| S14 教程端到端、50 对象＋20 路径性能、旧工程外观、录制回画布自动连线 | D05 §8；P F5／F7；D08 正式验收边界 | 保留现有录制／播放；`stageCommands.record` 与实际导出链；不是待新建编码器 | **partial，正式验收未关闭**：D08 明确区分 mounted Three／本地协议证据与完整 UI、WebKit／真实供应商证据。不能因 shell／timeline 存在即签收。 | L，验收 |

## 三、查看器、资产库与人物库

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| V1 外壳级全局媒体查看器：图片／视频、左右导航、缩放平移、提示词复制、元信息、全部动作、重新编辑／再生成 | D04 §2、§5；P F3 | 稳定资产引用解析、原始输入／来源元数据、工作台 regenerate／re-edit／导入能力均已有，D04 §8.1 | **missing／partial**：只有画布图片 viewer，`src/features/canvas/ui/ImageViewerModal.tsx:10-16,70-89,105-165`；视频用独立工具条 modal，`src/features/canvas/overlays/NodeToolbar.tsx:192-194`；资产详情又是单独 modal，`src/features/assets/ui/AssetLibraryPage.tsx:442-479`。没有统一右信息栏／动作全集。 | L |
| V2 查看器的嵌套菜单先消费 Esc、系统复制图片／统一快捷键 | D04 §5；D03 §6；P F7 | 已有 `useModalFocus`、图片剪贴板命令 | **partial**：画布 viewer 使用 modal focus 和左右键，`src/features/canvas/ui/ImageViewerModal.tsx:32-36,70-89`；未见 viewer 内的复制入口和完整嵌套动作菜单。需在 V1 合并后统一，而不是给三种 modal 各补一次。 | M |
| A1 资产类型／来源／比例／分辨率／模型筛选、按日期分组 | D04 §6、§8.1；P F3 | N2-A：`filterAssets` 已支持 resolution／width／height 等，`src/features/assets/application/assetCatalog.ts:151-173`；`groupAssetsByDate` `:176-187` | **partial**：类型、来源、比例、模型、搜索、收藏、日期分组均已接，`src/features/assets/ui/AssetLibraryPage.tsx:130-142,185-250,287-300`；缺分辨率筛选控件。 | S |
| A2 资产多选批量下载／删除／标签／送画布，拖到画布／Composer | D04 §6；P F3、历史 P1 | `tagAssets/deleteAssetReferences/importAssetToProject/downloadAssets`，`src/features/assets/application/assetCatalog.ts:190-225`、`src/features/assets/application/assetDownloads.ts:33-35` | **done，待 UI 验收**：批量条 `src/features/assets/ui/AssetLibraryPage.tsx:251-265`；拖动传选区全部 ID `:306-315`；画布接收 `src/features/canvas/io/useMaterialImport.ts:152-164`；Composer 接收 `src/features/workbench/ui/WorkbenchComposer.tsx:151-170,178-193`。不是只有拖拽协议文件。 | M，验收 |
| A3 资产「更多」统一动作与完整详情、文本单项下载 | D04 §1、§5、§6；P F3 | 原始下载、改名、收藏、来源元数据、字符创建 API 已有 | **partial**：动作散列为收藏、下载、引用、送画布、改名、删除，`src/features/assets/ui/AssetLibraryPage.tsx:355-411`；文本被排除单项下载 `:365`，尽管批量与服务已支持；详情只有媒体／正文，无元信息与完整动作 `:442-479`。 | M |
| R1 人物名字／多图／主图／音色／标签／空态／搜索／持久化错误 | D04 §6；P F3、历史 P3 | `characterLibraryStore` 提供创建、改名、图片排序／主图／标签，`src/features/characters/store/characterLibraryStore.ts:27-38,88-99` | **done，待 UI 验收**：列表、筛选、创建、投放画布 `src/features/characters/ui/CharacterLibraryPage.tsx:68-92`；多图／主图／排序和样本音色／provider voice `src/features/characters/ui/CharacterEditor.tsx:79-119`。音色克隆不可用已有明确说明，不应将保存音色信息宣称为克隆能力。 | M，验收 |
| R2 从任意图片节点／资产直接「创建人物」，生成输入 @ 优先人物 | D04 §6、§4.1；D03 §7；P F3 | `createFromAsset/createFromCanvasImageNode`，`src/features/characters/store/characterLibraryStore.ts:88-90`；人物优先选项 `getCharacterMentionOptions`，`src/features/characters/application/characterMentions.ts:20-43` | **partial**：图片工具条已有创建人物，`src/features/canvas/overlays/nodeActions.tsx:213-220`；资产页和节点右键缺该直接动作。生成 Composer 的 `PromptEditor` 仍只取上游 references，`src/features/canvas/composer/PromptEditor.tsx:32-43,93-100`；人物 mention helper 没有生成 UI 调用方。Agent mention 已有，勿混为同一完成项。 | M |

## 四、素材、工具箱、历史、知识库

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| L1 风格／特效／运镜素材库：搜索、正文、CRUD、启用、排序、恢复、JSON 导入导出、预览图、应用 | D04 §8.3；D03 §2；P F3、历史 P3 | `useMaterialLibraryStore`，`src/features/library/materials/materialStore.ts:39-151`；`applyMaterialToPrompt`，`src/features/library/materials/materials.ts:44-49` | **done，待 UI 验收**：完整管理页 `src/features/library/ui/MaterialLibraryPage.tsx:60-89,98-123`；外壳挂载 `src/features/studio/StudioShell.tsx:375-376`；画布也可达 `src/features/canvas/ui/CanvasLibraryDialog.tsx:52-68`。不能再按“整块未开发”排期。 | M，验收 |
| L2 组模板工具箱：保存、预览、命名／颜色、删除、选择项目采用 | D04 §8.3；P F3、历史 P3 | `saveGroupAsTemplate/instantiateTemplate/executionOrder`，`src/features/library/toolbox/toolbox.ts:20-81`；一次事务 `src/features/library/toolbox/toolboxStore.ts:57-63` | **done，待 UI 验收**：`src/features/library/ui/ToolboxPage.tsx:10-48,52-90`；保存入口 `src/features/canvas/overlays/SelectionToolbar.tsx:264-267`；项目采用 `src/features/library/ui/ProjectLibraryDialog.tsx:17-44`。缺口主要在 C14 的最近模板快捷入口，不是工具箱空白。 | M，验收 |
| L3 历史筛选／来源跳转／参数复用／友好详情 | D04 §8.3；P F3、历史 P3 | `filterGenerationHistory/jumpToHistorySource/reuseParams`，`src/features/library/history/history.ts:45-80`；原任务刷新 `src/features/library/history/canvasHistoryCapture.ts:89` | **partial**：来源／模型／状态／项目／日期筛选、结果、跳转／复用、分页已做，`src/features/library/ui/GenerationHistoryPage.tsx:24-43,59-70`；详情的参数仍是脱敏 JSON `<pre>`（`:70`），不等于 F3 所称友好参数详情。 | S–M |
| K1 vault 显式选择、笔记树／搜索／标签／反链、编辑预览、收录、整理、回收恢复、dirty 冲突 | D04 §8.2；P F3、N2-D | `useKnowledgeStore/KnowledgeService`；显式 open/init、轮询与安全 vault 边界已有 | **done，待真实桌面 UI 验收**：`src/features/knowledge/ui/KnowledgeLibraryPage.tsx:30-40,49-84,91-118`；dirty 外部变更与覆盖确认 `src/features/knowledge/ui/KnowledgeNoteEditor.tsx:35-40,76-97`；AI 整理显式选择模型与付费确认 `src/features/knowledge/ui/KnowledgeOrganizeDialog.tsx:13-38`。浏览器明确 desktop-only，不是假缺失。 | M，验收 |
| K2 附件独立浏览／导入／读取下载／移入回收站／恢复 | D04 §8.2；P F3、N2-D | `listAttachments/importAttachment/readAttachment/removeAttachment`，`src/features/knowledge/application/knowledgeService.ts:91-126`；Store 转发 `src/features/knowledge/application/knowledgeStore.ts:157-165` | **partial**：文件收录会 ingest 并建笔记；树能列附件，但非 note 的按钮被禁用，`src/features/knowledge/ui/KnowledgeLibraryPage.tsx:51-52,134-135`。UI 没有上述附件 API 调用；缺独立附件读取／下载及附件专用管理体验。 | M |

## 五、首页计划、迁移明细、图片建场景／3D

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| H1 首页 Agent 的完整计划预览：剧本、镜头、提示词、尺寸／模型、目标项目 | D06 §4、§9；P:90 | `prepareAgentCanvasPlan/resolveAgentCanvasPlan`，`src/features/agents/application/agentCanvasPlanRepository.ts:13-33`；`openAgentCanvasPlan` `src/features/agents/application/agentCanvasPlan.ts:54-80` | **done，待 UI 验收**：预览读取原始持久文档，不从脱敏日志重建；完整展示 `src/features/agents/ui/AgentApprovalPreview.tsx:14-74`；审批挂载 `src/features/agents/ui/ScopedAgentPanel.tsx:305-309`。这是历史 gap 已补项。 | S，验收 |
| M1 渠道迁移损失明细：字段路径、丢弃／转换／不支持、原因，不暴露旧值 | P:87、F6；D08 最新增量 | `describeChannelMigrationIssues`，`src/features/channels/application/channelMigrationIssues.ts:13-20`；分类 `src/features/channels/migrate/legacyConfig.ts:14-20` | **done，待 UI 验收**：卡片警告角标、编辑页详情已接 `src/features/settings/channels/ChannelSettingsPage.tsx:259-262,456-457`；安全表格 `:511-543`。不要重新实现。 | S，验收 |
| B1 视觉草案：显式视觉模型、确认后调用、后台继续编辑、预览、分项采用、一步撤销 | D05 §5；P:86 | `stageCommands.draftScene/applyDraft`，`src/features/stage/application/stageCommands.ts:143-145` | **done／部分最终视觉验收**：`src/features/stage/ui/StageDraftBuilder.tsx:31-62,66-101`；三层切换和后台状态 `src/features/stage/ui/StageSceneBuilder.tsx:30-42`。D08:114-124 已有本地协议行为证据，不是供应商理解质量证明。 | M，验收 |
| B2 2.5D 背景与真实 3D 必须区别呈现，预览取景／遮挡／最终采用可理解 | D05 §10.4；P:86、F5；D08 三级读图入口 | 深度估计／浮雕、真实模型导入与 Scene renderer 已有，不得退回预设摆放替代 | **partial**：三层入口已接；`src/features/stage/ui/StageScenePreview.tsx:10-30` 是真正隔离 Three 预览、前视 fit；D08:123 明确保留真实 3D 最终取景复核。不能把整个图生 3D UI 列为未开发。 | M |
| B3 图像→3D：模型／模式／槽位／声明参数、阶段进度、取消、刷新后原任务恢复、采用真实模型 | D05 §10.4；P F5 | `generateModelFromImage/recoverModelFromImage`，`src/features/stage/application/imageTo3d.ts:59-93`；导入 `src/features/stage/application/importModelFile.ts:10` | **done，待最终 UI／真实供应商验收**：完整 UI 与持久 jobId 在 `src/features/stage/ui/StageModelBuilder.tsx:26-109,116-153`；会显示 submit/poll/download/import 阶段、付费确认、停止等待、查原任务、采用 `importedModelId`。没有用户真实声明渠道时不能宣称某供应商支持。 | M，验收 |
| B4 我的模型库 GLB／GLTF 导入／列表／放置／删除与模型专属展示 | D05 §10.1–10.4；P 历史后续目标 | `list/get/rename/deleteImportedModel`，`src/features/stage/application/importedModelLibrary.ts:35-50`；真实 mesh 装载已集成 | **partial**：导入、元数据、放置、删除均已做 `src/features/canvas/ui/DirectorStudioShell.tsx:3505-3594`；“我的模型”卡片仍只有 Box 图标 `:3556-3559`，没有真实网格缩略／交互详情；重命名 API 没有该页入口。原生导入／最终取景验收仍独立。 | M |

## 六、ComfyUI 与跨页面一致性

这些不是“渠道模板 onboarding 重设计”；是 D07 明确的运行状态／恢复 UI 余项。

| ID／前端要求 | 规格来源 | 已有非视觉能力／依赖 | 当前 UI 状态与证据 | 规模 |
|---|---|---|---|---|
| I1 ComfyUI 协议显式选择、解析地址与剥离路径提示 | D07 §1.2 连接 | `resolveComfyUIUrls` 返回 `defaultedScheme/strippedPath`，`src/features/channels/adapters/comfyui/url.ts:44-69` | **partial**：三地址预览已有 `src/components/settings/ComfyBindingEditor.tsx:215-224`；连接表单仍是单 URL 输入 `src/components/settings/CustomImageProviderWorkbench.tsx:603-605`，未消费剥离／默认协议事实，也无显式协议控件。 | S |
| I2 同一连接多工作流的增删／命名／选择与模型投影 | D07 §1.2 工作流、§1.4；P N2-D／F6 | `add/update/remove/selectComfyWorkflow`，`src/stores/customProvidersStore.ts:158-184`；集合 schema `src/features/channels/application/comfyWorkflows.ts:22-29` | **missing**：UI 只编辑当前一份工作流；全仓 TSX 没有四个集合操作的调用方。现有连接页 `src/components/settings/ComfyUISettingsSection.tsx:39-58` 与单配置 editor 不能代替多工作流管理。 | M |
| I3 检查三级结果：版本／显卡／显存／队列、依赖预检、确认后最小试跑及缩略图／原文错误 | D07 §1.2 检查 | `inspectComfyUIConnection`，`src/features/channels/application/comfyConnection.ts:22-45`；`preflightComfyUIWorkflow`，`src/features/channels/adapters/comfyui/preflight.ts:10`；`submitComfyChannelJob`，`src/features/channels/runtime/comfyExecution.ts:315-334` | **partial**：节点输入选择、输出选择、预检及缺失项已有 `src/components/settings/ComfyBindingEditor.tsx:96-114,123-214`；未消费新统计服务，未找到统一三级状态及最小试跑结果 UI。negativePrompt 还被该 editor 显式排除 `:123-125`。 | M |
| I4 运行中任务改用新连接继续查询，显示原地址／新地址／原 prompt ID | D07 §1.2 任务、§1.4；P N2-D／F6 | `getComfyChannelRecoveryConnection/switchComfyChannelJobRoute`，`src/features/channels/runtime/comfyExecution.ts:398-412`；仅查询原任务且限制已保存连接 | **missing**：全 TSX／设置／工作台检索没有调用方。必须显式选已保存 ComfyUI 连接，不能做任意 URL 输入后重新 submit。 | M |
| I5 ComfyUI 当前执行节点／采样步数，WS 断线降级提示 | D07 §1.2 任务 | 既有持久任务／轮询可用；**本次未发现可直接消费的完整 WS 节点／步数 UI DTO** | **missing／非纯前端**：现有通用生成 UI 只有估算进度／阶段；不能承诺已有后端逐节点 WS 遥测，只留一个百分比外壳。需要先明确现有 gateway 实际可返回信息。 | M–L |
| G1 全局 ⌘K、按页面分组的 ? 快捷键面板、统一浮层挂载 | D04 §1、§2；D03 §7–8；P F2／F7 | 画布现有动作服务／快捷键表可复用 | **partial**：只有画布 `CanvasCommandPalette/CanvasShortcutsSheet`，`src/features/canvas/chrome/CanvasSheets.tsx:54-98,166-228`，且仅由 `src/features/canvas/Canvas.tsx:173-174` 挂载；外壳／App 没有全局入口。画布 palette 也不是全部应用命令／切画布入口。 | M |
| G2 统一 token／控件／文案／翻译、焦点／Esc 分层、小屏／长内容逐页验收 | P F7:62；D03 §11；D04 §5、§9；D05 §8 | 已有 `Ui*` 控件、focus／modal hooks、theme token | **partial**：不能依据组件存在签收。仍有明显未国际化旧 UI，如 `src/features/canvas/ui/AssetPanel.tsx:49-55,67-68,175-179` 的中文默认文案；库页面、媒体编辑器、舞台新控件需统一实际浏览器检查。 | L，跨页 |
| G3 巨型 UI 文件拆分，Canvas 只组装 ≤300 行 | D03 §10；D05 §1；P F7／历史 P3；D08 正式验收边界 | 现有 `engine/menus/overlays/panels/stage/ui` 分层已经建立，应沿用 | **partial**：`src/features/canvas/Canvas.tsx` 已基本拆分但仍 **323 行**；`src/features/canvas/ui/DirectorStudioShell.tsx` **3668 行**、`src/features/canvas/ui/BlueprintScene.tsx` **3499 行**，仍含大量交互／导出／库／渲染职责；`src/features/canvas/nodes/StoryboardNode.tsx:987-1301` 也仍大；`src/components/SettingsDialog.tsx:1379` 之后仍在同一组件。不要为满足行数新建无意义转发层。 | L |

## 七、明确交给其他侦察任务的项目

| 排除面 | 文档中的具体余项与当前事实 |
|---|---|
| Agent UI 重设计 | P F1；D06 §5–6：共享消息／工具步骤／审批／输入、渠道和运行时明示、@／skills、审批 hover 高亮、改参数、撤回整回合、外部镜像与诊断。首页计划预览 H1 已实现，勿重复。舞台常驻底部描述框 D05 §3 也应随此面接线，不与读图草案输入混淆。 |
| 工作台重设计 | P F2；D04 §3–4：共享 Composer、参考排序／首尾帧、模型分组与约束、会话项目／置顶、结果目录、任务抽屉、卡片动作。资产拖入 Composer／画布已实际接线；`StudioShell.tsx:134-141,351-352` 已有任务抽屉，不应按“完全缺失”重做。 |
| 渠道 onboarding／设置重设计 | P F6；D04 §7；D08 最新增量：能力分组、模板与模式切换、字段化、Agent 默认值／存储设置、凭据恢复指引等。**迁移损失 M1 已做；R7 resumable unknown 恢复按钮已做**，`src/features/settings/channels/ChannelSmokeDialog.tsx:115-125,166`；**stream 不可用控件已排除** `:65-67`；**文档上传已有键盘可达按钮** `src/features/settings/channels/ChannelSettingsPage.tsx:379-397`。重载后临时凭据重绑与完整浏览器验收仍应由该侦察任务核实。 |
| 外部 Agent 诊断与镜像 | D07 §2.2：安装／登录／接入／最近调用／修复与会话镜像。安装 diff／采用／撤销 UI 已有：`src/features/canvas/agent/ui/ExternalAgentInstallCard.tsx:16-161`；连接／审批 UI `src/features/canvas/agent/ui/ExternalAgentConnectionPanel.tsx:64-162`。完整诊断和外部对话交互归 Agent／接入侦察，不作为本报告新增设计包。 |

## 应优先修的真实接线问题

这些是静态源码能直接确定的契约冲突，不是视觉偏好：

1. **视频裁剪**：UI 传像素，服务收归一化。
   `MediaEditDialog.tsx:73` 使用 `videoSize?.width`；`media/types.ts:61` 要求 `rect.x + rect.width <= 1`。
2. **音频倍速**：UI 0.25–4，服务 0.5–2。
   `MediaEditDialog.tsx:191` 对照 `media/types.ts:69`。
3. **舞台总时长**：UI 静默把所有超出帧压到末尾，绕过拒绝截断的服务。
   `useDirectorStudioMotion.ts:417-420` 对照 `stageOperations.ts:269-272`。
4. **舞台路径应用**：UI 使用旧的“四秒＋删掉后续帧”路径，而 N2-C 已有保留区间外帧／自动步行动作。
   `useDirectorStudioMotion.ts:480-503` 对照 `stageOperations.ts:214-249`。
5. **舞台 hidden／locked**：数据／命令已支持，但可见 UI 仍单选并直接改 items；现有眼睛只藏标签。
   `StageOutliner.tsx:102,164` 对照 `stageSelection.ts:30`、`stageOperations.ts:185`。

## 看起来已经完成、不要再按历史缺口重建

- **图片旋转／镜像、视频播放与媒体编辑器、音频截取／切分／倍速入口**：真实处理层已接；只需修参数契约并验收。
- **图片 stack 主项切换／展开收起、画布节点树、连线拒绝原因、整卡连线落点**：UI 已有；缺的是结果条／拆分、树改名／全局资产等剩余项。
- **多选排列／资产保存／批量下载／添加 Agent／生成／组 skill／模板保存**：已做；缺分镜合并和整体 fan-in。
- **人物库、素材库、模板工具箱、历史页、知识库笔记管理**：都已有可达页面与画布入口，不再是整块空白。
- **首页 Agent 完整计划预览、渠道迁移分类明细、unknown 安全恢复、文档上传按钮、smoke stream 控件处理**：已有代码接线。
- **舞台三态看向、PIP、跟随／特写参数、K/I、hold、关键帧多选、三步引导、路径编号／虚线／长度**：已做，不应重新排整套实现。
- **视觉草案、2.5D、真实 3D 的三层入口；3D 阶段进度／取消／重载原任务恢复／采用；GLB/GLTF 我的模型库导入**：已做，供应商质量／最终取景／原生 UI 验收仍不能被本地夹具替代。
- **⌘D 历史缺陷已修**：外部边继承在 `src/features/canvas/clipboard/useCanvasClipboard.ts:61-81,225-227`；副本命名在 `src/features/canvas/clipboard/canvasDuplication.ts:68-70`。
- **连线剪刀跟随投影与流光**：`src/features/canvas/edges/DisconnectableEdge.tsx:135-183` 已实现。
- **千节点正常视野日常性能**：P 文首已有当前 Chromium/Metal 通过记录；不要拿旧 fit-all／百拖结果重新当作本次前端未实现项。

## 20 行摘要

1. 未写入 local://frontend-backlog.md：该角色强制只读且无写工具；完整可保存报告已在上方。
2. 本次只读检索源码与规格，没有运行任何构建、测试、lint、服务器或浏览器。
3. task_plan 历史 P2/P3 大量条目已过时，应按实际调用方拆成缺实现与待验收。
4. 最紧迫的画布接线错误是视频裁剪像素／归一化不一致和音频倍速范围不一致。
5. 最紧迫的舞台接线错误是缩短时长静默压帧，以及旧路径应用删除后续关键帧。
6. 节点标题 ⋯ 缺失，右键菜单与工具条 nodeActions 不是同一动作源。
7. 图片标题只显示比例，分辨率／像素 tooltip 尚未接；生成条只有估算，没有百分比文本。
8. generationFailure 已结构化，但节点失败界面仍未展示分类与明确可重试语义。
9. 图片 stack 已能切主项／展开收起，缺结果条、独立下载／拆分入口及其他媒体一致性。
10. 文本已有 Markdown、复制和展开，缺可视富编辑与单节点下载；批量文本下载已接。
11. 资产抽屉已有完整节点树与定位，缺树改名、全局资产页签／拖回画布体验。
12. 多选条多数动作已接，真正缺口是 storyboard.merge 与 selection.connect 的视觉入口。
13. 舞台 hidden／locked 只有数据／应用层，眼睛当前只藏标签；多选／框选／中心 gizmo 未接。
14. 舞台三态看向、PIP、跟随特写、K/I、hold、多关键帧与三步引导已经有代码。
15. 四视角／精确时刻捕获桥已经完成，但没有面向用户的控件与结果采用流程。
16. 全局查看器仍缺失：画布图片、视频工具条、资产详情各自使用不同 modal。
17. 资产库筛选／多选／拖放已接，主要缺分辨率筛选、完整详情／更多和文本单项下载。
18. 人物／素材／工具箱／历史／知识笔记页面已存在；人物 @ 优先与知识附件独立管理仍缺。
19. 首页计划预览、渠道迁移明细、图生 3D 生成／进度／取消／原任务恢复均已接，勿重建。
20. ComfyUI 多工作流／统计／换连接恢复 UI、全局快捷键／命令面板、巨型文件拆分及 F7 逐页验收仍开放。
