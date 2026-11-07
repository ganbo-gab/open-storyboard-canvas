# 渠道模型广场只读快速复审

2026-11-04。读取 ChannelMarketplace、ChannelModelEditor、ChannelSettingsPage、modelConnection 与它们的消费契约；未修改这些产品文件。以下确认问题均已通过团队消息交给主代理，本文记录发现时状态，最终修复以主代理集成为准。

1. `modelConnection.copyModelConnection` 只复制 OperationSpec，不复制或校验来源 profile.headers。具体例子：alibaba-wan-video 在 presets/videoModels.ts 声明必需 `X-DashScope-Async: enable`；从模板给现有渠道新增该模型时，mode.endpoint 保留路径/体而header丢失。需要拒绝与目标渠道不兼容的连接要求或有明确的按模型header契约；不能把来源header直接全局合并而污染已有模型。
2. `ChannelSettingsPage.testModels` 异步完成后无当前编辑对象检查，直接 setDiscoveredModels。查询渠道A后，用户可点返回并打开B（BackLink/openRecord不受busy限制），A结果迟到后成为B的“导入模型”选项。请求序号/编辑作用域或结果目标身份需固定，换对象后丢弃成功/错误/notice。
3. `ChannelModelEditor` 调用的 ModelModesEditor 可以只改 mode.operation 而保留 mode.endpoint。复制模板现在常为每个mode内联端点；把image模式下拉改为audio时，能力标签变音频，实际resolveJobOperation仍用旧图片端点和图片response.kind，形成错误请求类型。可令有内联endpoint的类型只读，或显式切到已经声明的新operation契约；不能只换标签。

未发现 Marketplace 自己复制任务/渠道事实：列表与模型明细投影现有channel store，使用模型转到工作台前会对有提示词/引用草稿确认覆盖；新模型来源需用户明确选模板或同渠道模型，没有按模型名字猜能力。上述问题均是连接/异步编辑边界缺口，不建议为此再建第二套渠道库。

## 三项修复复核与 README 能力边界

只读复核确认：copyModelConnection 的源 headers 检查已在函数和UI插入条件双重落实，header名称按大小写不敏感比较，不兼容时不插入；ModelModesEditor 存在mode.endpoint时禁用operation下拉并给高级完整契约提示；模型发现已绑定序号与draft/key/stage身份，过期成功、错误和finally都不会写入新编辑对象。

发现一个新边缘并告知主代理：ChannelSettingsPage 的 identity effect 无条件 setBusy(false)，busy 同时属于save/analyze；在save的credential写入等待期间编辑draft，会解除另一个操作的锁，允许二次创建/保存。应让busy归具体operation所有，或仅在取消实际discovery时释放发现锁。没有修改产品文件。

README 可准确写的 Agent 范围：

- Home：真实项目列出/创建/打开；剧本/分镜方案先预览后展开画布；资产检索；获批后给视觉模型看图片；工作台图片/视频/音频提交与原任务状态查询；渠道元数据、声明模式、配置草案预览和获批创建/更新配置。密钥由用户在设置输入，不交给Agent工具。
- Canvas：结构化画布查询、节点/连线/布局/生成/原任务恢复等命令；有界诊断与脱敏日志；allowlist非密钥配置patch的preview/apply/rollback；视觉模型获批读取图片。没有任意shell、任意文件或任意网络工具。
- Stage：查询真实目录/对象/机位/时间轴；story plan dryRun→带revision的原子应用；对象/姿势/动作/轨迹/机位关键帧编辑；真实挂载视口当前/指定时间/四视图截图和MediaRecorder预演录制。截图桥/编码能力不可用时会失败，不用旧图片冒充新验收。
- Knowledge：home/canvas/stage注册kb_search/read/write/organize，Canvas按本轮知识相关意图或选中技能启用。操作限已授权Markdown vault；read分页最多4000字符；整理使用选中的可用turn模型，最多20篇/120000字符。写笔记和AI整理需明确确认，知识文件不属于画布撤销。
- 手动模式：读取可自动，编辑进入审批；自动模式可自动非付费/非破坏性操作。付费/外部提交、破坏性操作、channel_create/update不能因auto而跳过确认；模糊的已受理付费请求不自动重提。
- Undo：可写“画布和舞台图编辑支持撤销/重做”。CanvasAgentDock有单回执事务回滚、最新整轮撤回，并检查工程/修订/后续历史，防止覆盖后续用户编辑。Home/Stage聊天面板没有同样整轮撤回按钮，相关图编辑仍在画布历史。付费任务、下载、知识库文件及渠道配置写入不被画布undo撤销；canvas config_patch有单独版本化rollback。不能写“所有Agent行为均可撤销”。
