# 舞台前端接线与交互实现

2026-11-04。遵循当前用户授权，以桌面为目标，没有增加手机布局。前序 generation 切片已完成；本报告仅描述舞台切片。

## 已实现

- **S1 真正隐藏与锁定**：对象列表眼睛控制 `hidden`，锁图标控制 `locked`；标签开关不再冒充隐藏。隐藏对象不渲染、不在文字标签/普通拾取/离屏取景出现；锁定对象不可从视口或时间轴新选中。对象列表仍可选择、显示、单独解锁。检查器禁用并有解锁入口。原有回调统一经过 `assertStageEditUnlocked`，保护删除/属性/对象和动作轨/被引用动作片段；纯解锁不能夹带其他修改。
- **S2 选择与批量**：新增局部瞬态选择 hook，复用 `resolveStageSelection`；Shift/Cmd/Ctrl 点击加减选，空地框选，列表与视口共享选择，时间轴选择同步主对象。顶部批量隐藏/锁定/解锁/删除调用 `executeSelection`，一次事务一次撤销。地面拖动可整体移动选区；多选 gizmo 位于选区包围盒中心，旋转/缩放/平移释放一次提交。含锁定对象的选区禁止变换，不偷偷只移动其余对象。
- **S3 双击聚焦**：视口双击实际对象调用现有 focusItem；轨迹双击插点和绘制结束保留。
- **S4 变换**：Cmd/Ctrl 开启 0.5m / 15° 吸附；默认地面对象移动隐藏Y轴，Shift临时解除；人物旋转默认Y轴，Shift解锁；变换显示Δ距离/角度。直接拖对象0.5m地面吸附。已有手势释放提交边界保留。
- **S8 时间轴**：拖动吸附0.1s、临近关键帧/片段边界和播放头（屏幕六像素容差，有上限）；Alt绕过。空间路径与机位rig边缘最短0.2s；拖动仍显示起止反馈。
- **S9 部分完成，保留V1语义**：S在动作轨分割程序动作或通过已有clip.split分割动作库片段；空间路径S插入保曲线切点，保留后续关键帧，**不声称形成两个独立路径片段**。Cmd拖空间轨复制关键帧范围。新增机位rig时间轴行，支持拖动/剪边/Cmd复制/S分割，及复制/置顶按钮；复用已有priority/rig helper。机位参数面板也有分割/复制/置顶。
- **S10 保留主代理本轮修复**：缩短时长继续使用prepareStageCommands的保护，不恢复静默压帧；S6画路线继续通过trajectory.set保留区间外内容。
- **S12 四视图与精确取景**：顶栏四宫格按钮直达右侧“截图”页，新面板切当前/指定时刻，调用 `stageCommands.capture/captureFourViews`，可停止、显示失败原因，四图可打开全局查看器。通过独立 `publishStageCaptures` 将1–4图一次性加到画布，并建立来源连线，一步撤销恢复；缺资产则整批失败。

## 验证与主代理浏览器入口

- `tsc --noEmit`：无错误。
- 定向 **9 文件 / 77 测试通过**：锁编辑边界、吸附、四视图发布原子撤销、真实motion hook、stage命令/capture、Outliner、CapturePanel、directorMotion。
- 四视图UI回归确认指定4.25s传给captureFourViews、四个原assetId整体发布，未用四次随意截图代替。
- 先前CapturePanel回归仅因jsdom无ResizeObserver失败；补测试夹具后通过，未改变产品语义。
- 没有启动浏览器或真实GPU/供应商，由主代理统一验收。需要实际检查：选区gizmo的中心旋转/缩放、拖动释放一步撤销、锁/隐藏后renderer更新、四视图取景与global viewer叠层、1024/1440桌面布局。
- 操作：空地左拖框选；Alt+左拖保留视角旋转，中/右拖平移；界面底部提示已更新。顶栏四宫格→截图tab→四视图/指定时刻。预演台rig行和机位参数面板可以分割/复制/置顶。

## 明确未闭环

- S3“选中机位时双击人物成为看向目标”未新增，目前双击为视角聚焦；现有看向下拉仍可使用。
- S5 视线虚线/可拖端点/R→free完整手势未补；既有target/point/free属性控件保留。
- S7 路径旁可拖时长胶囊、闭合开关未补；轨道边缘改时长与路径点编辑已可用。
- V1一对象只有一条空间轨道，路径复制后仍在同一关键帧轨道中；独立空间片段重叠/优先级没有假造第二套文档。显式优先级仅机位rig支持。
- 多选中心gizmo和UI当前只做静态/定向测试，尚无这批新的GPU/原生/WebKit验收。50对象+20路径、旧工程外观、录制回画布整个教程的S14须由统一验收继续确认。

## 文件

新增独立功能：`stage/ui/useStageEditorSelection.ts`、`StageSelectionBar.tsx`、`StageCapturePanel.tsx`、`StageRigTimeline.tsx`；`stage/application/stageEditProtection.ts`、`timelineSnap.ts`、`publishStageCaptures.ts` 及相应测试。

接线修改：`DirectorStudioShell.tsx`、`BlueprintScene.tsx`、`DirectorTimeline.tsx`、`DirectorCameraRigPanel.tsx`、`useDirectorStudioMotion.ts`/test、`StageOutliner.tsx`/test、`StageHeader.tsx`、`ui/stage.zh.json`/en、`src/types/three-examples.d.ts` 两个真实Three方法声明。

新增主功能拆到独立文件，没有继续把取景/多选状态/rig时间轴大块塞进Shell。没有变更全局App/index.css或主代理工作台/Agent代码，未操作真实工程/服务1420/Keychain/Git索引。

## 追加交付：S3 / S5 / S7 与截图验收修复

- S3：选中机位后双击对象会写 `camera.lookAt target`，首击转为对象选中也不会丢失双击前的机位意图；普通双击仍聚焦对象。复用舞台当前播放头和既有 cameraTrack，首个机位采用视口快照。
- S5：机位选中时显示相机线框、视线虚线与端点球。端点可在屏幕平面拖动，⌘ / Ctrl 吸附 0.5m；松手写 point 并清除跟踪/自由旋转。R 接同一个 TransformControls，松手写 free，完整保留 XYZ / roll。拖动预览作用于小窗而不修改持久数据；取消恢复原相机；自动运镜仍控制当前时刻时明确要求先烘焙，避免写入被运镜覆盖的无效关键帧。
- S7：选中对象轨迹/机位轨迹后，起点旁显示时长胶囊与开合环。拖“时长”标签或输入秒数可改轨迹时长，最少 0.2s，松手/Enter 一次提交；保留原关键帧 ID、朝向、缩放、缓动和时序比例。闭合增加返回起点的末点，原端点保留；再打开移除返回点并恢复整段时长。仍使用 V1 整条空间轨道，没有创建第二套片段文档。
- 修复 ScrubNumber 的 Enter→blur 重复提交与 Escape→blur 意外提交，避免一次编辑产生多条撤销。
- 截图面板在舞台内切到图层、收起属性区后仍保持挂载；换舞台按 nodeId 重新创建。新截图区已有图片时不再显示旧“还没有截图”空态。发送使用同步 ref，查看器同 tick 连续调用也只发布一次。
- 三处旧导航提示已统一框选 / Alt 环绕 / 右键平移，移除底部重复提示。
- 焦距纯函数移至 `domain/cameraLens.ts`，RigPanel 不再静态导入 BlueprintScene；Scene 保留导出兼容。没有新增渲染器或状态仓库。
- 相机视线辅助物从离屏截图、旧 PNG 导出、小窗与视频导出中排除，停止播放后恢复。

验证：6 文件 16 个定向测试通过（route 编辑保持/锁保护、机位显式三态、guide 的 roll 与目标方向、真实场景 capture、截图挂载/重复发送、ScrubNumber 提交语义），`npx tsc --noEmit --pretty false` 通过，改动路径 `git diff --check` 通过。日志：`/tmp/stage-followup-tests.log`、`/tmp/stage-followup-tsc.log`。

主代理仍需桌面浏览器验证：对象列表选机位 → 双击人物；拖视线端点；R 拖旋转环；绘制路径后拖时长胶囊、开合环；四视图后切图层/截图及收起/展开属性区保留结果。自动运镜区间先通过机位面板烘焙再做手动相机编辑。现有 procedural walk 的绝对步频未在此追加切片更改，空间路径改时长不宣称完成步频联动。

### 最后浏览器反馈对应修正

单选时隐藏顶部 StageSelectionBar，避免与上手引导/视图控制重叠。进入机位 R 工具时回到看路线并聚焦拍摄机位，以免 gizmo 位于观察视角之外；不修改机位数据。轨迹闭合操作排除并保留 stageRanges 生成的 before-/resume-保护关键帧；4.000001s 是区间外恢复边界，开合往返回归验证保留原帧。实际 R 拖动仍待主代理浏览器复验。
