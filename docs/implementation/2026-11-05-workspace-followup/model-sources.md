# 模型能力建议来源（核对 2026-11-05）

仅在精确模型 ID / 已列明别名匹配时补充缺失字段。不新增接入模型、不改模型 ID、不覆盖用户已填能力。请求协议是否能携带 tools/stream 仍由原渠道模板检查。第三方渠道实际上限可能更低。

已打开官方正文：
- OpenAI GPT-6 Astra、GPT-6.1 Sol、GPT-6.1 Terra：各自 developers.openai.com/api/docs/models/<id>，1,050,000 上下文 / 128,000 输出，图片、tools、stream。
- Anthropic https://platform.claude.com/docs/en/models/overview：Fable 5.1、Opus/Sonnet/Haiku 5.5，1M / 128K，图片及工具。
- Google https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash 与 gemini-3.5-flash-lite：输入1,048,576 / 输出65,536，图片及工具。
- DeepSeek https://api-docs.deepseek.com/quick_start/pricing：deepseek-flash当前V4.1 Flash，1M/384K，vision是；V4 Pro仍无vision。旧v4-flash别名路由Flash。百炼 https://help.aliyun.com/zh/model-studio/deepseek-v4-1-flash 确认ID deepseek-v4.1-flash与-1017及精确1,000,000/393,216。
- Qwen https://help.aliyun.com/zh/model-studio/qwen3-8-flash 与 https://www.alibabacloud.com/help/tc/model-studio/qwen3-8-max：1,000,000/131,072、原生视觉、工具。
- GLM https://help.aliyun.com/zh/model-studio/glm-5-3：1,048,576/131,072、仅文本、工具。智谱原始页搜索可见但提取失败，实际数值以已打开百炼正文为证。
- MiniMax https://platform.minimax.io/docs/m-plan/codex：M3.1-Flash官方1M，512K为建议日常客户端预算并非模型上限。支持图片/工具。输出限未填。
- Kimi https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart：kimi-k3.1-pro/highspeed，1M、视觉/工具；输出限未填。
- 豆包 https://www.volcengine.com/docs/ark/model-list：已通过Tavily raw正文核实2.1 pro/lite 260915为1024K/256K；pro/turbo 260628为256K/256K；多模态/工具。
- xAI https://docs.x.ai/developers/models/grok-4.20-0309-reasoning 与 grok-4.5：1M和500K，图像/工具，输出限未填。

不存在“全世界所有模型已覆盖”的承诺。未核实的旧/新模型、任意自定义别名维持未声明；用户可手填。此表是静态可审阅数据，不在启动时联网抓取，不因供应商发布而暗中覆盖配置。
