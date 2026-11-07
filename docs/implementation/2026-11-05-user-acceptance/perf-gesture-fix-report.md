# 自定义连续手势视口提交修复

日期：2026-11-05。仅实施 `perf-review.md` 中已确认的“逐帧 programmatic setViewport 导致 canonical/project 广播”问题。没有修改缩略图、画布裁剪、LOD 门槛或其他 store 的保存策略。

## 结果与实现

- `useCanvasGestures` 继续通过 requestAnimationFrame 实时更新 React Flow transform；右/中键 pointermove、自定义滚轮平移和缩放的画面更新不等待保存。
- 新 `canvasViewportGesture.ts` 在一段自定义手势期间抑制 D3 每次 programmatic setViewport 附带的开始/结束回调向 canonical/project store 提交；真正的 pointerup、pointercancel、blur 或滚轮 120 ms 静止后只提交一次。
- 结束时先取消尚未运行的 rAF并同步应用 pending transform，再从真实 `getViewport()` 读取最终结果。因此最后一帧不会被丢弃，也不假设请求坐标一定被 Flow 原样接受。
- 抑制 final transform 随后发出的零延时 move-end 回声；不匹配当前真实 transform 的过时 end 事件被忽略。原生左键/Space 与其他程序移动仍正常走 move-end 提交。
- Canvas 提交函数仅在 canonical 坐标实际不同时更新 canvasStore；仍独立执行 project viewport 保存，因此既有 WASD 逐帧 canonical 更新不会导致最终 project viewport 漏存。项目 owner/恢复阶段保护避免旧 hook 写入新项目。
- 通过 `application/canvasViewportCommit.ts` 注册唯一活动 owner 的回调。`projectStore.createProject/openProject/closeProject` 各仅增加一个 flush 调用，取快照/切换前同步收尾 pending 自定义视口。没有替换其他存储逻辑。
- 外部控件 pointerdown/keydown、pagehide 和 hook cleanup 也会收尾。卸载移除注册，旧 unregister 不会清除替换后的新 owner。

## 主任务可用 API

```ts
isCustomCanvasViewportGestureActive(): boolean
```

来自 `src/features/canvas/application/canvasViewportCommit.ts`，只读当前自定义 pointer/wheel 会话是否活跃。registry 只持有活动 callbacks，不存第二份视口或图数据；没有订阅原生 Flow 手势。可供主任务在新增媒体冷解码前检查，当前子任务没有加入任何 thumbnail 调度。

## 验证

```text
npx vitest run src/features/canvas/engine/canvasViewportGesture.test.ts src/features/canvas/engine/useCanvasGestures.test.ts src/features/canvas/engine/useCanvasGestures.commit.test.tsx src/features/canvas/application/canvasViewportCommit.test.ts src/features/canvas/hooks/useCanvasPersistence.test.ts src/features/canvas/agent/application/canvasAgentTurnSafety.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

6 文件、23 项通过。增加只读 active 查询断言后，关联 3 文件、13 项再次通过；最终 TypeScript 检查通过。

- 确定性调度回归中 20 次实时 transform 期间 canonical commit 为 0，release 应用最后 pending frame 后 commit 为 1；这属于行为/通知次数验证，不是真实浏览器帧率测量。
- 覆盖 pointerup/cancel/blur、wheel 连续输入和静止、外部控件前收尾、过时 callback、真实 transform 与请求不一致、owner 替换/卸载、release 后立即 close、wheel idle 前 close/open/create，以及目的项目视口不被旧项目覆盖。
- 保留原来的 pointer-transform hit-test 与 useCanvasPersistence 回归。

同轮修正全量测试发现的旧 `canvasAgentTurnSafety.test.ts` 附件 fixture：改为实际登记在 canvas catalog 的 uploadNode/assetId，并确认 `prepareAgentMediaSource` 确实被调用且卡住；仍验证附件准备受同一 10 分钟总时限约束，没有用无效附件绕过 deadline 测试。

## 性能证据边界

主任务的 before 生产浏览器基线存在约 1000 ms rAF 节流，不能据此宣布真实 FPS 或 input-to-photon 改善。本轮只确认移除了每帧下游 canonical/project 写入和保证最终位置正确；D3 自己的每帧事件仍由库产生。真实原生 WebKit 帧呈现、冷媒体解码和整体主线程占用继续由主任务 profile 判定。

未操作用户服务、浏览器、真实数据、凭据或 Git 索引；未重打原生包。
