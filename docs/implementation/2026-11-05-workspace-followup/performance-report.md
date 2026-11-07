# “火”平移排查补充 · 2026-11-05

## 实际保存内容（只读）

正式应用 projects.db 通过 sqlite mode=ro 查询，仅取“火”：70 节点、31 条边；7 upload、20 image、28 exportImage、11 blueprint、1 group、1 aiText、1 aiVideo、1 aiAudio。保存viewport zoom=0.6141。nodes JSON约124KiB、history约430KiB；无嵌入base64媒体。28个不同本地媒体文件约47.13MiB，当前最大文件5.66MiB，2624×1472；导入前原文件不一定与已保存文件一致。单张2624×1472解码RGBA约14.7MiB，这不是实测进程内存。

11个导演台节点中有5个含对象；无节点保存的snapshotUrl/snapshotHistory。节点内保存工程列表为空，但这不否定用户在独立舞台工程库中有工程。BlueprintNode仅在directorStudioOpen为true时挂载DirectorStudioShell；关闭节点不会持续运行3D。生产浏览器副本关闭导演台时canvas元素计数0，未见WebGL场景持续绘制。

## 已修复的通用缺陷

旧 beforeColdRender 只检查 isCustomCanvasViewportGestureActive：右键/中键/滚轮平移被保护，原生React Flow抓手/Space平移遗漏。新增isCanvasViewportInteractionActive读取当前挂载Flow的paneDragging；不增加每帧React广播，不改LOD/裁剪/像素清晰度，不持久化交互状态。缩略图开始前与源读取后均等待原生或自定义平移结束。CanvasNodeImage默认decoding=async。

实际手势验证中：抓手按住并移动时 nativeProtected=true、customActive=false，证明该缺口真实存在并已接通。相关42项回归通过，包括原生交互结束与owner卸载解除阻塞。

## 复现与证据范围

/tmp只读副本使用相同70节点/位置/31边/28本地图片，通过127.0.0.1媒体服务读取；生成句柄已移除，独立浏览器origin不操作原项目，不调用供应商。生产Chromium/DPR2/1188×858，10%fit附近，57挂载节点/15已加载图；对照70节点同位置改为简单上传节点，54挂载/16已加载图。两组均完成真实抓手平移，无卡死、错误图或状态重置。

采集CPU profile用于排除持续热循环；工具控制的输入存在间隔，不能把采样时长、rAF或ACK换算为FPS，不能据此宣称原生WebKit卡顿已经彻底消失。对照组也不是严格等媒体/等节点类型基准，不发布性能提升百分比。

## 仍需区分的技术债

- 缩略图仍在当前上下文使用createImageBitmap/OffscreenCanvas；并发2，有持久缓存，尚未迁到独立worker。首次解码/GPU上传是可达候选，但本次没有原生WebKit时间线证明其占比。
- 编辑后已经进入idle队列的整图序列化仍可能撞上后续手势。当前“火”的JSON不足1MiB，不能仅凭代码认定是主因。为避免影响关闭保存的可靠性，本轮未无证据重写持久化队列。
- 数据没有发现损坏证据；节点数本身并不足以解释卡顿。结论是已发现并修复一项通用交互调度遗漏，媒体内容可能放大首次操作成本，而非确认仅此项目有问题。

Windows和原生WebKit本轮没有重新跑图形性能测量。仍应在新macOS包里对实际使用路径验收。
