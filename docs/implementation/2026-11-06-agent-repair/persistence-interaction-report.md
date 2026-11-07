# 画布交互期间的普通项目保存延期

2026-11-06。仅改 `projectStore.ts` 与新的交互持久化测试。没有修改真实“火”项目、浏览器、LOD、缩略图或 Agent。

## 已确认的问题与修复

普通图编辑原本经过 debounce 后进入 idle callback，但 callback 真正执行时只检查项目是否被删除，未检查用户是否刚开始新一轮平移。`toProjectRecord` 同步编码并 stringify 节点、历史与媒体池，因而会在下一次抓手/Space/自定义拖动期间执行。

修复复用现有 `isCanvasViewportInteractionActive()`，在实际序列化前检查。普通保存交互中按 80ms 间隔重查，最多从首次入队延期 5 秒，避免一直拖动导致永不保存。到上限仍会保存，因此不声称任意长拖动都绝无序列化。

队列现在保留到真正准备执行；后续编辑替换尚未序列化的快照，同时保留首次入队时间和 immediate 意图。idle callback 可取消，且回调自身检查有效状态与当前队列身份，防止主机迟到回调写回旧内容。沿用原有按项目队列/timer，没有新增无界运行状态。

关闭项目、显式 checkpoint、重开前等待保存会取消/提升待执行工作，绕过交互延期；等待过程中出现新快照也提升为 immediate。已经开始的实际 native 写入仍串行，完成后继续最新版本。删除清理 debounce、idle 与延期回调，不会因为迟到任务复活项目。同步编码异常现在也进入既有持久化失败路径，避免 in-flight 状态卡住。

## 测试

新增 9 项行为测试：

- 编辑排队后开始 native 抓手/Space 拖动，序列化用的字段 getter 尚未读取；停下后保存；
- 更晚快照替换旧 idle 工作，故意送达已取消回调也不写旧内容；
- 立即关闭保存最终图一次；
- 明确等待可推进尚未触发的 idle 工作；
- 写入进行中又有更新，checkpoint 等待最新版本；
- 切换后重开先完成保存再读；
- 删除不会序列化旧数据或复活记录；
- 连续交互存在 5 秒保存上限；
- WebKit 没有 requestIdleCallback 的 timer fallback 同样延期。

```text
npx vitest run src/stores/projectStore src/features/canvas/application/canvasViewportCommit.test.ts src/features/canvas/engine/canvasViewportGesture.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

8 文件 71 项通过；类型检查与范围内 diff 空白检查通过。没有用这些时序测试替代原生帧率/呈现验证。

## “火”10% 平移的只读结论

复核主任务隔离 `/tmp/storyboard-huo-1105-readonly.json`（不打印内容）：70 节点，17 个图片源节点。按当前 full bbox + cover 算法，假设 zoom=0.1、DPR=2，17 个均选 256 tier，最大所需长边约 75 个设备像素。不能把持续 warm 平移卡顿直接归因于选择了全分辨率原图。

- 缩略图 hook 只在 zoom/tier 变化通知，纯 pan 不会逐帧换 tier；ref lease 和并发上限已存在。Worker 能减轻冷 decode/encode，对全部命中时的合成卡顿没有直接保证。
- `useCanvasNodeLevelOfDetail` 目前订阅全部 Flow 更新，每次 transform 更新会唤醒各节点 snapshot 检查；布尔值不变不等于 React 重绘，不能把检查次数冒充重绘次数。可先让订阅仅在 zoom 穿越阈值或 simplifyNodes 变化时通知，再测 native 主线程占用。
- `useCanvasBridges` 已仅在 zoom 数值改变时写 inverse-scale CSS；纯 pan 没有每帧改缩放变量。handles 的反向缩放可能影响合成层/命中测试，但需要 WebKit 图层 trace 对照，不能凭 CSS 断言根因。
- LOD 保留原 node bbox 对连线/位置正确性有意义。10% 的媒体很小，暂不建议为了性能缩 node geometry；可测试静止同画面条件下临时隐藏 handles/图片的诊断对照，测试结束恢复，区分合成/光栅与 JS。
- 可见 ID 计算每帧是 Flow 当前机制；70 总节点不自动说明其昂贵。需要同一次连续原生输入的 main-thread/layout/paint 时间线、可见集合变更次数与实际 frame presentation；工具分步拖动/ACK 不能作为丝滑证据。

本次只修复有确定调用链的保存碰撞，不能据此宣称“火”连续平移已经流畅。主任务的独立 WKWebView 验证负责这一结论。
