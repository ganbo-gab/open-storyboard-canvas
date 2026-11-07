# 工作区与配置改进交付 · 2026-11-05

## 已实现

- GRSAI旧快照结果查询兼容：按现有合同识别返回URL，业务错误立即暂停并显示诊断，不再空转；保留原任务，绝不重提。详细见generation-report.md。原真实图片尚未实际从供应商取回。
- 主导航、工作台记录、设置导航、知识目录可拖分隔线调宽，记忆宽度、键盘微调、双击复位，外观开关锁定及全局重置。
- 会话“归属项目”改为单行按钮/说明菜单；选后即时显示项目名并切换左侧筛选，该筛选下新建会话继承归属。说明后续生成资产归属与已有资产边界，不暗示自动放入画布。
- 图床AI：公开文档→选择已接入模型→单次分析→预览→应用未启用草稿。ComfyUI现有AI入口复用并强化校验。7个Agent工具跨首页/舞台/画布；配置预览后明确审批，不接受密钥，不自动上传、启用或执行工作流。见integration-config-report.md。
- 核查10家主流模型官方能力（OpenAI、Anthropic、Google、DeepSeek、Qwen、GLM、MiniMax、Kimi、豆包及xAI）：精确ID/别名补缺失元数据、来源与核对日期、手填优先；已有渠道运行投影也补缺失项。并非所有模型全覆盖，未知不编造上下文。见model-sources.md。
- 知识库入口改为普通本地Markdown文件夹，明确知识与资产职责；完整跨库去重/统一资料入口作为设计建议，未擅自改已有附件存储。见knowledge-direction.md。
- “火”只读70节点/31边/28文件对照，修复抓手/Space遗漏的冷缩略图交互保护，默认异步图片解码。无原项目写入。性能结论见performance-report.md。
- README同步上述能力与限制，补录分栏调宽/复位/项目归属GIF（生产版真实截图序列，14帧）。

## 验证

- 全量前端280文件/2571项通过；TypeScript、生产构建、Tauri macOS arm64 app+DMG构建通过。
- codesign --verify --deep --strict与hdiutil verify通过。版本仍0.2.0-next.1，adhoc签名未公证；新包使用正式identifier，未安装覆盖用户当前app。
- 隔离Ego浏览器生产版本：图床一次本地模型请求→预览→应用→保存刷新仍disabled，未上传；工作台分栏252→352px刷新保留、双击复位；设置240→300px；锁定后separator为0，解锁恢复3个；项目选择后筛选反馈/新建继承；模型模板接入deepseek-v4.1-flash能力自动填入。
- “火”副本和70节点对照均做生产抓手平移、图片加载；开发版额外确认Flow原生paneDragging期间保护为true。未宣称FPS或原生WebKit根因已完全消除。
- 本轮Rust未修改；上一轮213 Rust测试证据仍见生成恢复报告。本轮真实供应商原任务、真实文本模型/图床/Comfy服务、Windows与原生WebKit新图形性能未联调。
- 行尾检查通过；git diff --check只报历史未触碰docs/rework/05-舞台规格.md文末空行，未替用户整理。
- Git索引哈希保持14ab07df3bff02d0b7759ec60f8d20c1cf9fb4efaaed6475a06906eb7794bab4；未commit/push/stash/reset。用户1420服务、真实Keychain/CLI/项目未修改。

## 验收包

`/path/to/storyboard-workspace/验收包-2026-11-05-工作区与配置改进版/`

测试原任务请点原记录“重新查询/取回结果”，不要点“再次生成”。若供应商返回任务不存在/过期，新版应显示其业务诊断；本地保留任务编号并不保证供应商永久保留结果。
