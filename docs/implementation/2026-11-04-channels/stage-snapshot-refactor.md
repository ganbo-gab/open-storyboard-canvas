# 舞台截图生命周期职责提取

2026-11-04。一个有界切片：从 DirectorStudioShell 提取截图媒体规则、截图操作生命周期和 renderer capture 注册。不动渠道/设置/全局样式/国际化，不改舞台文档和播放/变换语义。

## 结果与边界

`DirectorStudioShell.tsx` 从 3709 行减到 3411 行，减少 298 行。它现在负责把用户动作和舞台输入交给截图边界，继续保留项目保存/切换、场景编辑和界面布局。

- `stage/application/stageSnapshotMedia.ts`：唯一的截图 URL 历史去重、十张上限、追加顺序、data image 持久化、批量历史持久化、比例/尺寸计算、等下一渲染帧规则。项目保存封面与截图操作共享这些函数，不再在 shell 各自实现。
- `stage/ui/useStageSnapshotActions.ts`：拥有当前舞台截图的选择/删除/清空/生成、画布发布、发布 busy、闪光与toast反馈。统一一次异步操作的生命周期；同步 ref 防重复发布；舞台关闭或切换舞台项目后，旧异步结果不能再写节点或发布到画布。清空历史可使正在编码的旧截图失效，避免迟到回填。未新建 store，持久状态仍是原 node.snapshotUrl / snapshotHistory。
- `stage/ui/useStageCaptureRegistration.ts`：负责 stageCommands 到当前视口的注册/注销、committed inputs 与 renderer revision 校验、冻结一批捕获时间、离屏渲染、资产登记与失败清理。保留 `createStageCaptureBridge` 事务与既有资产目录；当前帧/指定时刻/四视图仍在同一个命令边界，未引入第二套截图 API。

保留旧行为：截图默认尺寸、横竖比例、历史顺序与上限；发送全部按原顺序；canvas callback 返回 false 时不关闭舞台；清空/删除历史只去掉引用，不删除真实素材；保存项目封面仍可用已保存截图回退。Three renderer 的动态分块没有变成运行时静态导入，新增模块只 type-import BlueprintScene 类型。

## 验证

6 文件 21 个定向测试通过，`/tmp/stage-structure-tests.log`：

- 现有真实挂载 DirectorStudioShell capture：execute→capture 在 React/mesh 同步前拒绝，渲染器旧 revision 拒绝；同步后成功。
- 现有 BlueprintScene capture：旧 revision/unmount/编码期间输入变更等完整捕获保护。
- 现有 StageCaptureBridge / StageCapturePanel 契约。
- 新 useStageSnapshotActions 行为：十张历史、同tick重复发送只发布一批、callback false 保持舞台、删除当前后回到末张、不在unmount后发布/写入、清空不被迟到编码覆盖。
- 新 stageSnapshotMedia：横向、纵向和不裁切视口的尺寸保持。

最后 `npx tsc --noEmit --pretty false` 已通过，日志 `/tmp/stage-structure-tsc.log`；改动路径 `git diff --check` 通过。没有跑全量、浏览器或付费调用。最终生产浏览器与全量验证由主代理集成。

## 诚实的架构范围

这是责任收口，不是所有舞台债务已清完。Shell 仍约 3.4k 行、BlueprintScene 仍很大，项目库/场景编辑/imperative Three交互仍需要后续有回归约束的小切片。本次新增 hook 有真实生命周期所有权，应用模块有共享媒体规则，不是纯粹参数转发，也没有引入平行状态机或重写文件格式。
