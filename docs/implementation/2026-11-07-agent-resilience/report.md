# Agent 长任务恢复与渠道参数引导

日期：2026-11-07。范围：三个内置 Agent 共享执行链、渠道模板帮助与尺寸展示、README。保护真实项目、渠道与钥匙串；验收使用独立数据、脚本模型传输，不新增真实供应商付费请求。

## 已修复

1. **并行工具图片打断协议批次**：Chat 原先发送 `assistant(A,B) → tool A → user 图片 → tool B`，DeepSeek 可拒绝缺少 B 的输出。现在先输出整批工具结果，再发送图片。Gemini 同批 functionResponse 合并到一个用户轮次；Anthropic 保留 tool_result 内图片。
2. **未知工具丢失结果**：不再静默删除未知或未暴露的工具调用。交给 SDK 返回工具不可用错误，保留 call ID；不会执行未授权工具。避免 Responses、Gemini、Anthropic 原生续聊状态中保留调用却丢失对应结果。
3. **有限重试**：明确 429/500/502/503/504 且尚未开始响应时，最多重试三次，采用抖动退避；可读到 Retry-After 时遵守它。余额/配额、鉴权、协议/参数、部分输出、未知网络受理均不自动重放。原生 HTTP 桥未提供响应头时不能宣称使用了上游 Retry-After。
4. **长任务与并发**：每回合 96 工具调用、30 分钟（含审批等待）。旧会话历史不占当前回合恢复计数。三种作用域阻止同会话并发回合；同回合不同审批不能同时推进。已有预算、修订检查、付费幂等边界保留。
5. **中断恢复**：失败时先终结审批与运行权限，再从 SDK 的公开原始输入/运行条目恢复历史，非流式失败可用最后一次模型请求输入。已保存结果优先；缺失项用真实回执或明确“未确认”补闭合，不伪造执行成功，不重执行工具。第一回合失败仍保留会话身份。
6. **审批后的反馈与取消**：同一 Agent 保留工具闭包，审批时切换到当前操作的事件回调、重试提示与 AbortSignal；没有重新提供的回调保留原订阅。修复旧 UI epoch 丢弃事件和工具收到旧停止信号的问题。

首页和舞台面板提供“继续未完成的部分”入口，保留未发送草稿。画布可继续发送指令；所有内置 Agent 显示重试进度。外部 Codex/Claude CLI 使用自己的运行时，未宣称由本应用控制其内部重试或上下文压缩。

## 渠道参数

模板问号与连接页指南提供连接、选模型、审阅三步，路径与参数从模板自身派生，说明像素值、比例/档位及视频时长类型。移除公共模板中的个人 CC API 推荐文字，不删除用户已有渠道。

像素选项可选原尺寸或比例+分辨率展示；两控件只能选择已声明的组合，最终仍发送同一个原始接口值，auto 等特殊选项保留。可编辑标签及原有高级参数、JSON、请求映射。独立 ratio/resolution 模板保留原生字段，不猜测其 1K 像素含义。metadata 同步纳入 TS/Zod 与 Rust 快照校验，包含 SQLite 重新加载回归。

## 验证与边界

- 真实 SDK/控制器配本地传输，包含 36 个连续舞台对象编辑及逐步撤销、96 调用预算、30 分钟停止、三作用域并发、失败后重新打开会话、三次重试耗尽、退避取消、审批后工具取消。
- 10 个并行工具（含两份图片结果）严格配对；未知工具混合合法调用覆盖 Chat、Responses、Anthropic、Gemini，流式与非流式共八种路径。
- Rust 合同测试 5 项通过：三份合法快照、79 类 TS 拒绝变体及存储回读；不接触真实数据库或钥匙串。
- 完整前端检查：315 文件 / 2815 项通过；TypeScript、生产构建及行尾检查通过。构建保留已有大资源 chunk 提示。
- 浏览器验收先用独立 1527 开发端口，后用 1528 生产预览避开 HMR：模板问号、连接/手填模型、参数显示切换、2:3 对应 1024x1536 与 auto 保留。工作台预览的临时选值不会改保存的默认值；实际请求值另外由合同测试验证。未保存真实渠道、未发网络生成。
- Mac aarch64 生产 app 和 DMG 已构建。独立原生 QA 使用同一生产前端、独立 identifier `com.ganbo-gab.storyboard-agentqa1107`，能够启动；CUA 应用解析仍命中旧同名包标识或返回 Invalid app，**本轮原生界面交互没有完成**，不能把浏览器验收写成 WKWebView 验收。旧画布性能验收见原报告；本轮也没有 Windows 实机测试。

界面证据：[模板帮助](channel-help.png)、[比例与分辨率预览](ratio-preview.png)。本轮使用 ad-hoc 签名，没有 Apple Developer ID 公证；不覆盖 `/Applications` 中已有安装。

交付：`验收包-2026-11-07-Agent可靠性与渠道参数/Open Storyboard Canvas_0.2.0-next.1_aarch64.dmg`，38,446,813 bytes。`codesign --verify --deep --strict` 与 `hdiutil verify` 均通过。SHA-256：`76c1c897aaaeff4aa7071584428ebc8eab33e56228ff38d93d9111af1db72359`。

不能将脚本回归等同于所有供应商实测，不承诺 Agent 零错误、无限续跑或断电后自动恢复正在执行的工具。没有新增自动摘要/上下文压缩；超出模型窗口仍可能失败。保留已有会话存储限制并显式报告，不静默截断未配对工具批次。

## 官方资料

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)
- [OpenAI image generate](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [OpenAI video generation](https://developers.openai.com/api/docs/guides/video-generation)

用于核对公开协议和参数语义，没有声称复刻 Codex 内部实现。
