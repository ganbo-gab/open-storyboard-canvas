# 生成记录可溯源详情

2026-11-04。参照用户 video-maker 的 DetailPopover，采用人可读字段表、单独原始提示词与上游提示词、任务信息和折叠技术记录。没有复制其账号/计费系统，没有新建数据库或日志事实源。

## 共享调用 API

`src/features/library/ui/GenerationDetailsDialog.tsx` 导出：

```tsx
<GenerationDetailsHost /> // App 已由主代理挂载一次
openGenerationDetails({ taskId: task.id, jobId: task.jobId }); // 工作台
openGenerationDetails({ nodeId }); // 画布节点，支持切换这个节点的历史提交
openGenerationDetails({ recordId }); // 固定历史记录
openGenerationDetails({ jobId, recordId, nodeId }); // 日志跳转
```

也可直接渲染 `<GenerationDetailsDialog target={...} onClose={...}/>`；推荐使用全局host统一所有权。它的store只保存当前打开对象，不存第二份任务事实。

## 已接入

- 节点动作菜单新增“详细信息”。
- 画布日志每条生成任务有详情按钮；能关联历史时显示当时提示词摘要、模型、发起位置，并可定位关闭工程/工作台来源。
- 浏览器日志也投影已有 generation history，避免没有原生日志时整个任务线索消失；不会新造日志持久层。
- GenerationHistoryPage使用同一详情，移除旧的仅JSON详情框。
- 同节点前几次提交可以切换，旧任务与节点当前任务单独显示，不把当前参数覆盖旧记录。

## 展示内容

发起位置、工程/来源节点、节点当前名称、渠道、实际请求模型、模式、比例、分辨率、时长、提交数量、质量、种子、参考数、结果数、状态、阶段、提交/更新时间、本地任务ID、上游任务ID、保留的原结果、脱敏错误。

普通信息用字段表；IDs位于任务分组；技术诊断折叠。结果可打开全局查看器，提示词可以复制；另有“复制脱敏诊断”和“定位来源”。可确认恢复的任务使用已有recover接口，只查询/下载原任务，不提交新生成。

## 事实与隐私边界

- `loadGenerationDetails`只读取本地现有history、workbench任务、原生持久job和浏览器快照。**没有调用会自动查询网络的getCustomProviderJobAsync**；打开详情不会触发供应商请求。
- 不读当前provider/model配置补历史字段，没记录就是“未记录”。原生坏行/缺失记录失败与已有历史信息分开处理。
- 旧 `record.prompt` 有时是编译内容、有时是草稿，无法凭空判断，因此不称最终上游提示词。
- 在既有HistoryRecord增加可选 `upstreamPrompt`；新 `captureCanvasGeneration` 只有明确拿到 `context.prompt` 才记录。旧记录继续缺省，不执行批量迁移，不存Headers或请求body。工作台没有确定最终wire prompt时明确未记录。
- 可复制诊断使用已有redaction/sanitizer，排除凭据、绝对路径、内嵌素材和signed URL敏感值；技术记录只选最小必要字段，不展示整份provider配置/恢复快照。
- 旧Comfy原生多结果可以从保留assets重建；浏览器IndexedDB key不会当URL渲染。只有key而未水合且历史没保留可显示source时，会提示无可显示结果，不伪造预览。

## 验证

- 定向5文件 **17测试通过**：详情投影、旧prompt不冒称upstream、实际upstream保留、多结果/opaque key、敏感信息脱敏、browser日志投影、对话框定位来源、既有history/drawer/nodeActions。
- tsc无错误；diff-check通过。
- 日志 `traceability-tests.log`、`traceability-tsc.log`。
- 无真实供应商/用户文件读取、付费调用、CLI/Keychain或Git索引修改。实际浏览器布局/复制/来源跳转由主代理统一验收。

## 文件

新增：`library/application/generationDetails.ts`及test；`library/ui/GenerationDetailsDialog.tsx`及test；`i18n/locales/ui/details.zh.json`/en。

修改：`CanvasDiagnosticDrawer.tsx`、`canvas/overlays/nodeActions.tsx`、`GenerationHistoryPage.tsx`；既有history.ts/historyStore.ts/canvasHistoryCapture.ts可选upstreamPrompt契约与history.test回归。

`i18n/index.ts`现有import.meta.glob自动发现details资源，不需要再添加全局列表。没有修改主代理的GenerationCard/WorkbenchComposer/PromptEditor或全局CSS。
