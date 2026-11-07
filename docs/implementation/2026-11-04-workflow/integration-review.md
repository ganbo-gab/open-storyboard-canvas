# 本轮独立集成复审

2026-11-04。当前结论：本次确认的结果可靠性、历史归属、参考输入和详情事实缺陷已修复。没有发现需要再次推倒底层重构的证据；仍有明显的旧编排层负担，不能把当前代码称为已彻底清理完成。本文不替代主代理的全量测试、生产浏览器验收和原生供应商验收。

## 变更归属依据

以 `baseline.json` 的文件 SHA-256 对比当前文件，区分本轮新增文件、本轮触及文件和未变旧文件。该基线只有散列，没有完整旧源码，不能据此断言触及文件中的每一行都是本轮新写。`workbenchStore.submit` 异步归属问题、旧 GenerationCard 的普通 references 写入路径可在 Git HEAD 找到，属于既有逻辑；本轮新查看器与会话入口扩大了这些路径的可达性。`canvasHistoryCapture.ts` 在基线已经存在；本轮触及了提示词追溯，其任务身份匹配问题不冒称本轮才引入。

本轮新增的 `generationDetails.ts`、`GenerationDetailsDialog.tsx`、`ComfyRecoveryControl.tsx`、浏览器任务记录解析与进度适配器，以及本轮修改的工作台/Agent/画布菜单均已做有边界的代码阅读。PromptEditor 的已完成独立复审未重复开展。

## 确认并修复的问题

1. **成功任务被历史回填降级**。`WorkbenchPage.tsx` 打开对话会补读成功 Comfy 批次；`workbenchStore.poll` 原先遇到旧 job/cache 缺失、空结果或查询异常，直接把已有本地成功结果改成 recoverable_wait。Comfy 缓存库与工作台 workspace media 库独立，因此这不等于工作台结果已丢失。现在补读失败保留原成功事实/结果；实际拿到更多输出才补全。补充结果落盘失败也保留已成功的原结果。显式恢复仍查询原任务，未新增提交。
2. **旧失败记录吸入新一次原地生成**。`canvasHistoryCapture.ts` 原先无条件按 resultNodeIds 匹配，且继续更新失败/取消历史；全景节点原地重做时旧 attempt 会得到新 job 的状态、错误和结果。现在记录有 jobId 时必须匹配原任务，当前 generationJobId 优先于旧 generationLastJobId；无身份不能凭节点 ID 猜测。无 job 的已失败/取消记录冻结，保留初次记录证据。
3. **缺本地结果时恢复连接入口消失**。`getComfyChannelRecoveryConnection` 原先先 hydrate 结果字节；字节缺失会让 `ComfyRecoveryControl` 吞掉异常并隐藏，无法选新地址。现在连接信息只读既有元数据，不下载、不查询旧主机；明确切换连接时才进入原任务恢复。UI 显示读取失败并可重试，换地址保持同一个上游 prompt ID，没有 POST。
4. **结果“用作参考”绕过显式槽位**。旧 GenerationCard 只写 draft.references，而显式模式按 referenceSlots 组包，可能提示已添加但请求不携带这张图。主代理新增 `appendReferences.ts` / `workbenchStore.addReferences` 后，上传、拖入、资料库、结果卡与查看器共用槽位分配；满槽明确报错，整批不部分写入。
5. **异步准备完成后任务归错对话**。旧 submit 在 externalizeAssetMedia 之后才读取 selectedConversationId。用户等待素材准备时切换对话，任务会进入另一个对话，chat 还会带错上下文。主代理已在该异步边界之前固定发起会话。
6. **详情参考数与工程归属失真**。显式模式参考图只在历史 params.referenceSlots 中，原详情显示 references.length 可错报为 0；原工作台投影也未带对话工程归属。现在参考数只依据保存的 slots 与文本 refs，避免双计旧媒体 refs；不读当前草稿。`projectWorkbenchHistory(task, agent?, conversationProjectId?)` 保持前两个参数兼容：显式历史 input.projectId 优先用于提交归属；currentProjectId 用于当前对话工程筛选，并由 projectAttribution 标明来源。更改对话关联立即改变筛选，详情单列“对话当前工程”，不会冒充“当时发起工程”。没有历史提交工程时明确未记录；当前无关联时明确未关联。

## 舞台最后验收反馈

- StageSelectionBar 仅多选大于 1 时显示，单选沿用底部工具条/检查器，避免顶部叠层重复。
- 4.000000 与 4.000001 的相邻关键帧来自 `stageRanges.ts` 的一微秒保护边界，保留被编辑区间之外的状态，并非重复数据。新增的轨迹闭合判断/开关明确排除并保留 before-/resume-保护帧；回归验证开合往返不删除它们。
- Shell 的 R 按钮、快捷键和 Scene props 已允许选中机位；机位可能在当前观察视角之外。现在进入机位旋转会切回“看路线”并聚焦机位，使 gizmo 可见；只改变观察相机，不改变已记录的拍摄机位。此项仍由主代理做实际浏览器验收。

## 底层架构结论

- **核心边界真实存在。** 渠道声明/schema、执行器、原任务恢复、工作台文档、资产媒体、历史投影已有分层。详情只保存打开目标，读取现有事实；菜单复用 useNodeActions / canvas actions；新引用入口已合并；没有为本轮前端再创建一套任务数据库或画布文档。
- **缓存一致性仍值得重点约束。** runtime jobs、workbench tasks、canvas history 并非都应视为独立事实源：前者负责上游与本地下载，工作台拥有已保存输出，历史必须绑定 attempt。此次确凿缺陷正来自把低层 cache 失败覆盖成功事实、把可复用节点误当 attempt 身份；修复已补守卫与行为回归。
- **舞台旧编排层仍厚。** DirectorStudioShell 约 3.7k 行、BlueprintScene 约 3.8k 行，选择、imperative Three、姿势、轨迹、截帧与浮层生命周期仍集中；useDirectorStudioMotion 同时存在旧 updateMotionProject 路径与新共享命令路径。新手势复用了命令层并拆出纯 route helper、camera guide、controls，但这只是逐步收口，不能说所有旧编辑均已统一。
- 建议后续按现有行为逐块提取视口交互控制器和领域编辑入口，保留现有文档与命令契约；无需再引入第二套 store/schema，也不建议为了文件行数盲目重写。当前未确认有因这些体积问题而必须阻断本轮发布的数据损坏缺陷。

## 验证范围

- 可靠性/原任务路由/历史身份/guard：5 文件 57 个定向测试通过，日志 `/tmp/integration-followup-tests.log`。
- 详情事实/当前归属/历史 store/工作台：4 文件 47 个定向测试通过，日志 `/tmp/details-followup-tests.log`。两组有重叠，不相加宣称独立测试总量。
- 最后 `npx tsc --noEmit --pretty false` 与改动路径 `git diff --check` 通过，日志 `/tmp/details-followup-tsc.log`。
- 未启动全量测试、浏览器、用户服务、真实供应商或付费调用；主代理负责最终生产验收。没有修改 Git 索引。
