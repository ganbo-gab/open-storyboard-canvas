<div align="center">

<img src="docs/brand/open-storyboard-canvas-icon.png" width="112" alt="Open Storyboard Canvas 图标" />

# Open Storyboard Canvas / 开源画布

面向 AI 图片、视频与分镜创作的本地节点画布。

[下载最新版](https://github.com/ganbo-gab/open-storyboard-canvas/releases/latest) · [使用与开发文档](docs/) · [加入 QQ 群](#交流与反馈) · [报告问题](https://github.com/ganbo-gab/open-storyboard-canvas/issues)

</div>

## ❤️ 友情赞助

<table>

<tr>
<td width="180"><a href="https://torchai.ai"><img src="docs/partners/torchai.jpg" alt="TorchAI.ai" width="150"></a></td>
<td>感谢 TorchAI.ai 赞助了本项目！<a href="https://torchai.ai">TorchAI.ai</a> 核心主营 GPT 号池与 Claude 号池，自主搭建 Pro / Max 账户池，全力保障稳定流畅的 GPT 调用体验；无掺假、无套壳，只做真实、稳定、高性价比线路。企业对接倍率更低，支持 10000 RPM，可测模型。点击<a href="https://torchai.ai">此链接</a>了解更多。</td>
</tr>

</table>

## 项目简介

Open Storyboard Canvas 把参考素材、提示词、AI 生图/生视频、分镜拆解、导演台、全景环境和结果管理放进同一个可无限扩展的本地画布中。

它不是只能“输入提示词—下载图片”的单次生成器，而是一套可连接、可追踪、可恢复、可继续编辑的创作工作流。应用基于 Tauri 2、React、TypeScript 与 Rust 构建，支持 macOS 和 Windows。

> [!IMPORTANT]
> **画布 Agent 当前为测试版。** 它已经可以理解画布、调用画布工具、创建与修改节点、提交生成、查询任务、读取脱敏日志并协助诊断，但不同文本模型的工具调用质量存在差异。涉及付费生成、配置修改或删除操作时，请留意执行模式、工具回执和供应商费用。

## 主要能力

### 画布 Agent（测试版）

- 在画布右侧直接对话，理解当前项目、选中节点、附件和上下文。
- 可创建、查询、移动和编辑画布节点，并实时把执行结果反映到画布。
- 支持手动与自动模式；自动模式仍会在删除节点前请求确认。
- 生图/生视频提交后持续跟进任务状态，完成后可从对话定位输入节点和结果节点。
- 支持文本、图片和视频模型选择，多模态模型可读取用户明确授权的图片。
- 显示简洁推理摘要、工具调用、批准卡、失败信息和可展开的技术详情。
- 可读取脱敏应用日志与生成任务，诊断配置、参数、网络、上游和结果获取问题。

### AI 图片与视频工作流

- 从零生图、参考图编辑、图生视频和分镜派生结果。
- 统一管理供应商、模型、比例、分辨率、时长、数量和扩展参数。
- 支持 Agnes、自定义 OpenAI 兼容供应商及其他声明式供应商配置。
- 支持本地 Dreamina（即梦）CLI，并保留上游任务句柄用于安全查询和结果恢复。
- 对异步生成任务进行持久化跟踪；提交结果未知时不会自动重复可能计费的请求。
- 结果下载支持本机代理、受控重试、同源鉴权和可恢复任务。

### 节点画布与标签组

- 上传图片/视频、AI 文本、AI 图片、AI 视频、分镜、全景和导演台等节点。
- 大画布使用几何索引、窄订阅和缓存，降低大量节点与连线时的重复计算。
- 标签组可以收纳图片、视频和文本引用，减少素材占位，并作为普通参考素材连接到生成节点。
- 标签组成员在 `@` 选择器中仍以普通图片、视频和文本出现，不会向生成提示词注入额外的“标签组”描述。
- 支持撤销/重做、项目持久化、节点定位和生成任务回执。

### 导演台与全景

- 在 3D 场景或全景背景中安排人物、道具、灯光和摄影机。
- 支持角色动作、自定义姿态、摄影机控制、画幅调整和导演台录制。
- 可以把导演台截图送回画布，继续作为构图参考或生成输入。
- 支持文生/图生全景、全景查看、保存当前视角和四宫格参考图，并可把生成或上传的全景导入导演台作为空间背景。
- 导演台由错误边界保护，单个场景渲染异常不会直接拖垮整个画布。

### 创作效率与诊断

- 表格批量导入提示词，一次创建多组画布任务。
- 提示词预设和提示词库用于浏览、收藏与复用镜头、动作、风格和场景描述；提示词管理支持编辑内置功能提示词、切换默认语言和恢复默认内容。
- AI 图片节点继续支持参考图、比例/分辨率、生成张数、模型参数、预设提示词与摄像机控制；图片工具栏保留多角度、打光、编辑、宫格切分、复制、下载和预览等能力。
- 画布左侧提供人类可读的日志入口，可搜索、筛选、查看脱敏原文并重新获取安全结果。
- 项目文件导入/导出与应用设置备份/恢复分开处理，凭据默认不导出。
- 画布节点、边、视口、历史记录和媒体引用自动保存到本机项目；支持浅色/深色主题、中英文界面，以及适配 macOS 与 Windows 的桌面交互。

## 界面预览

| 功能 | 预览 |
| --- | --- |
| AI 图片节点：模型、参数、摄像机控制、张数与提示词集中配置 | <img src="docs/imgs/readme/ai-image-node.png" alt="AI 图片节点" width="520" /> |
| 摄像机控制：相机、镜头、焦距和光圈描述 | <img src="docs/imgs/readme/camera-control.png" alt="摄像机控制" width="520" /> |
| 图片节点工具栏：多角度、打光、编辑、切分、预览与下载 | <img src="docs/imgs/readme/image-node-toolbar.png" alt="图片节点工具栏" width="520" /> |
| 导演台：人物、道具、全景环境、摄影机与灯光调度 | <img src="docs/imgs/readme/director-studio.png" alt="导演台" width="520" /> |
| 导演台全景背景导入 | <img src="docs/imgs/readme/director-panorama-import.png" alt="导演台导入全景图" width="520" /> |
| 自定义供应商设置 | <img src="docs/imgs/readme/provider-settings.png" alt="自定义供应商设置" width="520" /> |
| 提示词管理：编辑内置提示词、切换语言和恢复默认内容 | <img src="docs/imgs/readme/prompt-management.gif" alt="提示词管理" width="520" /> |
| 提示词预设：保存并复用常用正向提示词 | <img src="docs/imgs/readme/prompt-presets.png" alt="提示词预设" width="520" /> |
| Dreamina / 即梦 CLI 设置 | <img src="docs/imgs/readme/dreamina-cli.png" alt="Dreamina 即梦 CLI 设置" width="520" /> |

## 下载与安装

前往 [GitHub Releases](https://github.com/ganbo-gab/open-storyboard-canvas/releases/latest)：

- Windows：下载 `open-storyboard-canvas_<版本>_x64-setup.exe`。
- macOS：下载 `open-storyboard-canvas_<版本>_universal.dmg`，同时支持 Apple Silicon 与 Intel Mac。

安装提醒：

- GitHub Tag 页面只有源码压缩包，桌面安装包请从 Releases 页面下载。
- macOS 包目前没有 Apple Developer ID 签名和公证。首次打开若被拦截，请在“系统设置 → 隐私与安全性”中允许打开，或右键应用后选择“打开”。
- Windows 若提示缺少 WebView，请安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 后重试。
- 请只从本仓库 Releases 下载，并核对版本号与文件名。

## 首次使用

1. 新建或打开一个画布项目。
2. 在“设置 → 我的配置”中添加文本、图片或视频供应商；也可以配置 Dreamina CLI。
3. 从左侧创建上传、AI 图片、AI 视频、导演台或标签组节点。
4. 在节点上手动生成，或点击画布右上角 Agent，让它协助完成任务。
5. 若生成失败，从左侧“日志”查看可读原因；有安全任务句柄时可以重新获取结果。

供应商配置说明：

- [开发与基础工具安装](docs/development-guides/base-tools-installation.md)
- [项目开发环境](docs/development-guides/project-development-setup.md)
- [供应商设置指南](docs/settings/provider-guide.md)
- [ComfyUI 连接指南](docs/settings/comfyui-guide.md)
- [中转站生图兼容配置](docs/settings/image-relay-compatibility.md)

## 数据、隐私与费用

- 画布项目、节点、边、视口、历史和媒体引用默认保存在本机应用数据目录。
- API Key 与自定义供应商配置保存在本地设置中；应用不会提供云同步账号系统。
- 设置备份默认不包含凭据。只有用户明确选择并确认风险后，才会导入或导出明文凭据。
- 生成时，提示词、参考素材和参数会发送给用户选择的供应商或本地工具。供应商如何计费、保存和处理数据，以其服务条款为准。
- Agent 自动模式不会消除供应商费用。提交未知或费用不明的生成请求不会被自动重复。
- Issue、截图和诊断包会进行脱敏，但发布前仍请检查是否包含私人素材、客户信息或凭据。

更多说明见 [SECURITY.md](SECURITY.md)。

## 本地开发

### 环境要求

- Node.js 20+
- Rust stable
- Tauri 2 所需系统依赖
- macOS：Xcode Command Line Tools
- Windows：Visual Studio C++ Build Tools、WebView2

### 启动项目

```bash
git clone https://github.com/ganbo-gab/open-storyboard-canvas.git
cd open-storyboard-canvas
npm install

# 前端开发
npm run dev

# 当前源码桌面应用
npm run tauri dev
```

### 质量检查

```bash
npm test
npx tsc --noEmit
npm run build
npm run check:line-endings

cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目结构

```text
src/
  commands/                 # TypeScript → Tauri 命令桥接
  components/               # 通用组件与设置页
  features/canvas/          # 画布、Agent、导演台、节点、模型与生成工作流
  features/portability/     # 项目和应用设置迁移
  features/promptLibrary/   # 提示词库
  stores/                   # Zustand 状态与持久化协调
  i18n/                     # 中英文语言包
src-tauri/
  src/commands/             # Rust Tauri 命令、网络代理与本地系统能力
  src/ai/                   # AI 供应商适配
  tauri.conf.json           # 桌面应用配置
docs/                       # 使用、开发、发布与授权文档
```

## 交流与反馈

欢迎加入 Open Storyboard Canvas QQ 交流群，交流使用经验、反馈问题或提出功能建议：

**QQ群：1025837759**

遇到需要跟踪和复现的问题，也欢迎通过 [GitHub Issues](https://github.com/ganbo-gab/open-storyboard-canvas/issues) 提交。

## 贡献

欢迎提交可复现的 Bug、供应商或模型适配、性能优化、文档修正和交互改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

提交 Issue 时建议附上：

- 应用版本和操作系统；
- 使用的供应商类型、模型与关键参数（不要附 API Key）；
- 可复现步骤；
- 左侧日志中的可读信息，必要时再附脱敏原文或诊断包。

## 授权与上游归属

本项目基于 Storyboard-Copilot 二次开发，并已获得原作者公开/书面聊天授权继续开发与开源。授权条件是保留原作者名称和原项目链接。

- 原作者：痕继痕迹 / henjicc
- 原项目：[henjicc/Storyboard-Copilot](https://github.com/henjicc/Storyboard-Copilot)
- 授权截图：[docs/legal/upstream-author-authorization-2026-05-31.jpg](docs/legal/upstream-author-authorization-2026-05-31.jpg)
- 归属说明：[NOTICE](NOTICE)
- 本项目新增代码与资源按 [MIT License](LICENSE) 发布。

## 免责声明

- 用户自行管理 API Key、本地凭据、供应商配置、CLI 登录态和产生的费用。
- 第三方供应商的请求失败、内容审核、数据处理、区域限制、账号风险与服务中断由对应服务方及用户自行承担。
- AI 生成内容可能涉及版权、肖像权、商标、事实性和商业使用风险，发布或商用前请自行确认。
- 本项目不承诺任何供应商、模型、网络服务、Agent 决策或生成结果始终可用、准确或适合特定用途。

## 致谢

感谢 [Linux Do](https://linux.do) 社区、原项目作者以及所有提交 Issue、PR 和测试反馈的用户。
