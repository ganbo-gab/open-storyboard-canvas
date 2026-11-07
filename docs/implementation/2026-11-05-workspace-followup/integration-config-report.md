# ComfyUI / 图床辅助配置与 Agent 配置工具

2026-11-05。沿用现有设置组件、channelChat、ComfyUI 工作流 schema、图床 v2 schema 和 Scoped Agent 审批。没有读取真实凭据、调用付费模型、上传文件、执行 ComfyUI、改用户配置或操作 Git 索引。

## 用户界面

图床设置新增“AI 帮我配置图床”：粘贴公开上传文档或无密钥示例 → 选择已经接入且可用的文本模型 → 明确“分析一次” → 查看上传 URL、文件字段、JSON 结果路径、需自行填写的 header 名称 → 应用草稿。

- 文本模型只调用一次，不抓取链接、不重试修复、不测试上传。
- 只支持既有单次 POST multipart 上传合同。模型 schema 没有 header 值、SecretRef、启用开关或额外表单字段；不支持多步登录/token/signature 流程。
- 复用渠道助手既有文档脱敏，并在本地剔除当前图床已有 header 值、opaque SecretRef、curl header 值。已有配置不作为模型消息发送。
- 结果严格校验 URL、header 名称、响应路径；URL 查询参数/userinfo/hash 不进入 AI 草稿。旧 header 值全部保留，新的名称只添加空值，应用后强制 disabled，用户自行检查凭据与启用。
- 文档、模型或原配置改变会丢弃旧建议；异步返回后再次核对原配置，避免覆盖用户后续修改。
- ComfyUI 现有助手补了应用前工作流一致性检查；绑定校验拒绝凭据输入、对象值与连线，仅可选真实标量输入和已有输出候选。不会改工作流提示词正文。

## Agent 能力与审批

7 个工具在 home、stage、canvas 注册：

| 工具 | 用途 | 风险/审批 |
|---|---|---|
| integration_list | 列出真实 ComfyUI 连接/工作流 ID 与图床公开元数据 | read |
| integration_comfy_read | 读取节点类型、输入类型/连线、绑定、输出候选 | read |
| integration_comfy_preview | 校验已有工作流绑定与输出建议，生成前后预览和 draftId | read |
| integration_comfy_apply | 应用该 draftId 对应的绑定与输出 | edit，自动模式也要求明确审批 |
| integration_image_host_read | 读取上传地址（无查询）、字段、header 名称与启用状态 | read |
| integration_image_host_preview | 校验 Agent 自己推理的图床草稿并生成 draftId | read |
| integration_image_host_apply | 将该草稿写为 disabled，保留旧 header 值 | edit，自动模式也要求明确审批 |

Agent 配置工具不调用另一个模型；由当前 Agent 直接根据已提供的结构/公开文档推理。apply 只接受 draftId，不接受替换配置或凭据。草稿绑定 projectId/runId、30 分钟有效期、最多 64 项、一次消费，使用真实原配置身份检测 stale。应用时再次校验，旧草稿、另一个回合、配置改变均拒绝。审批卡展示本地保留的校验后前后字段，而非相信模型传来的说明。

ComfyUI 写入仅改变已有工作流的 bindings/outputNodeIds；连接、header、API Key、工作流节点输入/提示词保持原值。图床写入只变三项元数据与新增空 header 名称，关闭启用；保留凭据。最终元数据更新在现有 Zustand 持久化 store 内同步提交并复查基线，避免在等待凭据迁移时覆盖另一处编辑；没有新建配置仓库。原有持久化故障仍由现有 storage 层处理，未新增跨 store 事务。

跨作用域沿用 createScopedSdkTools、审批执行一次与技能 whitelist。canvas 的原 scoped 桥仅在知识任务触发，本次扩大到 ComfyUI/图床相关请求或明确 integration_* whitelist；没有另建 bridge。全局配置编辑不触发画布 checkpoint/撤销。全局设置没有画布撤销语义，用户可在设置中重新修改。

小范围公共接入文件：agentToolNames.ts（注册）、sdkRuntime.ts（canvas 触发）、agentAutoApprovalPolicy.ts（两项 apply 不自动批准）、scopedAgentSdkTools.ts（无画布 checkpoint）、canvasAgentController.ts（真实草稿审批摘要）、configurationAssistant.ts（导出复用的脱敏函数）。没有改分栏、ModelCapabilitiesFields、ChannelTemplateConnection、知识实现或 README。

## 验证

`npx tsc --noEmit` 通过。

10 个文件、90 项测试通过：

```text
npx vitest run src/features/settings/imageHostConfigurationAssistant.test.ts src/features/settings/imageHostSettings.test.ts src/components/settings/ImageHostConfigurationAssistant.test.tsx src/features/agents/application/scopedIntegrationTools.test.ts src/features/agents/application/scopedAgentTools.test.ts src/features/agents/application/scopedAgentReviewRegression.test.ts src/features/channels/application/comfyConfigurationAssistant.test.ts src/features/channels/application/comfyWorkflows.test.ts src/features/channels/application/configurationAssistant.test.ts src/features/canvas/agent/infrastructure/sdkSkillPolicy.test.ts --pool=forks --maxWorkers=2
```

包括：DOM 选择模型/单次分析/二次应用/丢弃迟到建议；文档与已有 header 值脱敏；schema 不接受凭据或启用；真实 store 中保留凭据和工作流提示词；home/stage/canvas 工具注册；草稿跨回合、过期、stale；真实 SDK 未批准不改配置、批准后写入 disabled；自动模式仍需批准；canvas 技能 whitelist 保持生效；相邻渠道文档、ComfyUI 工作流、Agent 回归。

仅行为与类型验证。没有浏览器截图/视觉验收，也没有真实文本模型、图床或 ComfyUI 服务联调。模型是否准确理解某供应商文档仍取决于其实际输出；界面保留人工预览与应用步骤。用户先前已有的原生成结果恢复是另一条链路，本报告不宣称取回其图片。
