# “火”项目首次平移卡顿：只读代码复审

日期：2026-11-05。此次只读产品代码、已安装依赖源码和主任务准备的隔离项目/媒体映射，未修改产品、未操作浏览器或 1420 服务。以下区分代码可确认的问题与需要浏览器 trace 定位的候选；没有据此更改性能门槛。

## 结论

普通平移结束不会因此做整图持久化，关闭的 Canvas Agent dock 也没有每帧遍历/序列化全图。已确认自定义右/中键及滚轮平移存在每帧“开始→结束→canonical/project store 广播”的额外工作；最符合“第一次卡、随后顺”的另一条候选是新图片进入视口后的冷缩略图解码/编码，以及已排队的编辑保存恰好进入下一次手势。前者有完整调用链证据，后两者必须与实际 WebKit/浏览器主线程、图片解码和磁盘时间线对齐才能定主因。

## 本次实际负载

- 主任务隔离副本：69 节点、31 边。类型为 7 upload、20 image generator、28 exportImage、10 blueprint、1 group、1 aiText、1 aiVideo、1 aiAudio。
- 只读 `/tmp/storyboard-acceptance-fire.json`：154,367 字节，viewport zoom 为 1.806245，0 选中节点，生成状态已由主任务安全停用。
- 其中只有 17 个节点有 imageUrl；16 个有 previewImageUrl，5 个 preview 与 original 同地址。10 个 blueprint 均无 snapshotUrl/snapshotHistory/directorStudioProjects，且输入边数量均为 0。
- 主任务提供的 28 个本地映射文件中，通过 `sips -g pixelWidth -g pixelHeight` 只读得到总计 40,967,121 像素；5 张原图为 2624×1472，11 个独立预览长边为 512。全部原图在副本中都是 URL 引用。
- 因此“约 49 MB 本地文件”不代表每次保存序列化 49 MB，也不代表当前可见/已解码 49 MB。全部 28 文件各解码一次约 156 MiB RGBA 只是理论像素容量，不是实际 RAM 测量。历史记录不在副本中，不能用此副本估计真实历史序列化成本。
- 可见/挂载节点量、实际 DPR、浏览器引擎、当前内存/持久缩略图命中状态，需要由主任务 profile 一并记录。不能将 69 个总节点当作同时挂载数量。

## 1. 可确认：自定义平移把每帧当成完整移动

调用链：

1. `src/features/canvas/engine/useCanvasGestures.ts:73` 的调度器逐 rAF 调用 `reactFlow.setViewport(pending)`（79）。右/中键的 pointermove 在 171–185，滚轮平移在 116–119，均走该调度器。
2. `node_modules/@xyflow/react/dist/esm/index.mjs:527` 转到 `panZoom.setViewport`；`@xyflow/system/dist/esm/index.mjs:3103` → `setTransform`（3005），没有设置内部手势标记。
3. `node_modules/d3-zoom/src/zoom.js:85` 的无动画 transform 会对每次调用执行 `.start().zoom().end()`（91–96）。
4. `@xyflow/system/dist/esm/index.mjs:2836` 发 start；2865–2887 发 end，当前 `panOnScroll=false` 因而采用 `setTimeout(..., 0)`。React Flow 在 `index.mjs:1340` 转发给产品 `onMoveEnd`。
5. `src/features/canvas/Canvas.tsx:93` 的 saveViewport 每次执行 `canvasStore.setViewportState`、`saveCurrentProjectViewport`；后者 `projectStore.ts:1314` 更新 currentProject 并重排 280 ms viewport 写入。

**影响边界：** 这增加每帧 0 ms task、canonical store 与 project store 订阅通知和 timer 操作；不是每帧 SQLite 写入，也不是每帧整图保存。原生 React Flow 左键手形/Space 拖动与自定义右/中键路径不同，是有用的对照组。

**最小建议：** 为自定义手势建立明确起止边界。移动期间只更新 Flow transform；在 pointerup/cancel/blur，或滚轮真正静止时，再合并一次 canonical viewport 与持久化调度。产品 onMoveEnd 需区分仍在进行的自定义手势，避免它每帧提交。保留程序 fitView/定位、取消、窗口关闭的最终 viewport 保存；不能简单忽略全部 `event === undefined` 的程序移动。

**profile 判据：** 一次持续右键拖动期间 saveViewport/canonical viewport commit 是否接近 rAF 次数；与同路径 warm 图像和 Space/左手形拖动对比。它是确认存在的多余工作，但仍不能凭代码断言它单独造成首次长卡顿。

## 2. 优先候选：进入视口时立即触发冷缩略图工作

- `Canvas.tsx:298` 保持 `onlyRenderVisibleElements`；React Flow 可见 ID 在 `node_modules/@xyflow/react/dist/esm/index.mjs:2129` 以当前 viewport 边界计算，没有额外预加载带。新节点跨边界会挂载其内容。
- `useCanvasImageThumbnail.ts:198–201` 只对同一已显示 source 的 tier 变更等待 120 ms；新 source/重新挂载第一次立即 `start()`，不检查正在平移。
- `useCanvasImageThumbnail.ts:194–196` 先 acquire 预览；168–171 发现预览小于目标 tier 时再 acquire 原图。在当前 zoom≈1.806、若 DPR=2，168 px 的图片边需要约 607 设备像素，会选 1024 tier；512 预览不能覆盖，会继续原图解码。实际 DPR 需主任务确认。
- `canvasImageThumbnails.ts:180–185` 已有并发 2、idle LRU 96，**不是无限并发**；285–306 的 durable miss 仍立即读源、render、写入 IndexedDB 后才呈现。
- `canvasImageThumbnails.ts:416–436` 先 `createImageBitmap(blob)` 全分辨率解码，再第二次 resize bitmap，最后 drawImage/编码 WebP。392–409 的 OffscreenCanvas 运行在当前调用上下文，没有 Worker；不能把异步 API 自动等同于完全不占渲染线程。
- 第一轮的源读取、解码、编码和 GPU 纹理上传完成后，内存 entries/idle 和持久缓存都会命中，符合 warm 路径变顺的机制。
- 图片 `<img>` 默认 decoding=auto（`CanvasNodeImage.tsx:150–158`）；新 bitmap 的 `<img>` 显示还可能形成另外一次 decode/upload 排程，实际是否阻塞呈现需看引擎 trace。

**最小建议（trace 确认后）：** 已有清晰度较低的预览继续呈现，把交互中的新增大 tier 解码推迟到手势静止；完成后仍恢复满足真实设备像素的 tier，不降低静止清晰度。没有预览时维持明确 pending，不偷用原图触发另一份全图解码。若证据是仅进入边界抖动，可考虑很小、受限的预取带/短暂复用已显示媒体，保留现有裁剪，不能为了分数全图常驻。

**可分开的次级优化：** 305 行先等 `writeDurable` 再 materialize，会让已生成像素等待 IndexedDB 完成；如果 trace 显示是“图晚出现”而非 CPU 卡顿，可先展示已生成像素再做缓存写入。这是图片就绪延迟优化，不能冒充已经修复输入卡顿。

## 3. 可确认风险：编辑保存任务不会因下一次平移而暂停

- `useCanvasPersistence.ts:109–118` 的图编辑保存 timer 默认 140 ms；159–166 订阅忽略 viewport-only，但捕获图/历史/真实 measurement 变化。
- `projectStore.ts:61–65` 整图队列再等 260 ms；`scheduleIdlePersist`（604–615）使用 requestIdleCallback(timeout=1200)，无该 API 时 fallback 为 64 ms timeout。
- `flushProjectUpsert`（684–707）执行前只检查删除状态，不检查新手势；`toProjectRecord`（521–540）同步 encode、JSON.stringify nodes/edges/history/imagePool。
- `Canvas.tsx:98` 的 cancelViewportSave 最终只清 viewport 队列（`projectStore.ts:1335–1340`）；不取消 `useCanvasPersistence` 图保存 timer，也不取消已经排出的 idle 全图任务。
- 新挂载媒体节点的 `updateNodeInternals`（ImageNode.tsx:95、UploadNode.tsx:121）可能带来 measurement 变更。`canvasStore.ts:1184` 已过滤相同 measurement，不能断言每次挂载都整图保存；尺寸真正变化时仍可能入保存队列。

**结论：** “仅 pan end 导致整图保存”不成立；“刚编辑/尺寸更新后开始下一次 pan，先前整图保存撞上手势”成立为可达路径。仅此 154 KB 无历史副本未证明序列化很慢，需 trace 的 `toProjectRecord/encodeProject/JSON.stringify` 和真实历史大小佐证。

**最小建议：** 在非显式 flush 的 executePersist 前增加交互状态检查，手势结束再合并最新版本执行；保存 timer/idle 任务应可延期或失效，而非只取消 viewport timer。关闭项目和持久化等待的 immediate intent 必须优先，不能引入数据丢失或无期限延迟。

## 4. 关闭 Agent dock：没有发现本轮担心的全图热序列化

- `CanvasWorkspace.tsx:17` 的 dock 始终挂载，`CanvasAgentDock.tsx:1100–1122` 用宽度/透明度隐藏，所以 UI 关闭并不等于卸载。
- 但关闭时 `CanvasAgentDock.tsx:200` 使用 `selectCanvasContentNodes`，其 `canvasContentSelector.ts:11` 对相同 nodes 数组立即返回；纯 viewport 不改变 nodes。几何-only新数组只做一次共享字段引用比较（15–24），保持内容投影引用稳定。
- `useCanvasAgentAttachments.ts:21–29` 的资产目录使用 useMemo，仅投影变化时重建。`useAgentComposerAssist.tsx:71–80` 只在 @ picker 打开时加载 mentions，并不随 pan 收集全库。
- dock 的 contextEstimateTokens（217–223）只统计 feed 文本/草稿和附件数，没有 JSON.stringify 全图。
- `CanvasAssetPanel.tsx:40–45` 关闭时订阅 EMPTY_NODES，不构建目录。生成节点的隐藏 NodeComposer 在 `NodeComposer.tsx:49–52` 已停止 graph-reference 订阅。
- 仍可优化但优先级低：若关闭前停在 tasks，`GenerationTasksPanel.tsx:67–71` 的每 4 秒 listGenerationJobs(50) 仍在运行；隐藏 dock 有 feed 更新时仍会渲染。可拆分持续任务所有者与可见视图，但不应为此停止正在运行的 Agent。

额外确认：BlueprintNode.tsx:134 的 selectInputImageSignature 在 canonical store 通知时仍计算和 JSON.stringify；但是 graphReferenceResolver.ts:263–277 有内容索引 WeakMap 缓存，而本项目 10 个 blueprint 的入边都为 0，因此不能把它描述成“10 次全图 JSON 序列化”或本项目已确认主因。

## 5. LOD、布局与 WebKit 边界

- 当前 zoom≈1.806，远高于 0.4 LOD 阈值（canvasZoomRendering.ts:15），纯平移不会切 LOD。`useCanvasImageThumbnail.ts:101–107` 只在 zoom 改变时通知 tier；平移不主动改变 tier。
- LOD 订阅每个 Flow/UI store 事件仍会计算布尔 snapshot（useCanvasNodeLevelOfDetail.ts:10–21），React 只在值变化时重绘。Node body props 排除位置/dragging（NodeRenderErrorBoundary.tsx:5–15）；不用把每帧 Flow transform误称为所有节点 body 重渲染。
- Blueprint 的 raw snapshot `<img>` 确实未接缩略图缓存（BlueprintNode.tsx:415/452），但本项目没有任何 snapshot，此候选在当前复现中排除；3D shell 仅在 open 时挂载（509），也不在当前关闭画布热路径。
- 右/中键开始会写 `data-pointer-transform`（useCanvasGestures.ts:219）与 `data-panning`（179）；CSS 在 canvas.css:36、914 改 cursor 与 edge pointer-events，可能产生一次 style/hit-test 更新。只是可观察切入点，尚无证据说明 31 边导致长卡顿。
- 滚轮另有 `canScrollNatively`（useCanvasGestures.ts:31–49）逐祖先 getComputedStyle、scroll/client尺寸读取。若 WebKit trace 显示首次 wheel 强制 Layout，可缓存最近滚动容器或缩小读范围；该代码不解释纯右键 pointermove 的卡顿。
- WebKit 需确认 createImageBitmap/OffscreenCanvas 能力和缩略图错误日志。缩略图失败会被记住（canvasImageThumbnails.ts:318–320/338），hook 退回 prepared preview 或原图（useCanvasImageThumbnail.ts:183–185）；不能假设浏览器热缓存结果就是原生 WebKit结果，也不能没有错误证据就宣布 API 不兼容。

## 建议 profile 对照

在相同 zoom、DPR、viewport、可见节点和已挂载媒体数量下比较：

1. 进入图片区域第一轮 vs 同区域第二轮；同时记录 thumbnail generated/durableHits/heavyQueued、实际图片 ready 和输入呈现时间。
2. 右键/中键/自定义 wheel vs React Flow Space/左手形，观察一段真实手势内 onMoveEnd 和 canonical/project store commit 次数。
3. 稳定空闲后开始平移 vs 一次编辑后 0–1.5 秒内开始平移，查整图序列化是否撞上输入。
4. 可见集合不变的小平移 vs 新媒体节点跨视口边界，区分 JS订阅、mount/layout和decode/raster。

不以 rAF 调用次数或 ACK 作为 presentation/input-to-photon；不改裁剪/LOD门槛、不预先全图解码后把 warm 数字当冷启动结果、不在有真实生成句柄的原项目上做复现。
