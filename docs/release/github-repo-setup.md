# GitHub Repository Setup 建议

这个文件用于公开仓库维护 GitHub About、Topics、Release 和对外展示信息。

## About Description（≤ 120 字符，英文前置 + 中文补充）

```text
Local-first AI storyboard infinite canvas for storyboarding: 3D Director Studio & multi-provider AI | 本地桌面AI分镜节点画布
```

> 字符数：114 字符（含空格与符号），命中 `local-first`、`AI storyboard`、`infinite canvas`、`storyboarding` 等高频海外检索词，同时清晰说明多供应商 AI、三维导演台与本地桌面节点画布定位。

## Topics（15 个，小写短横线格式）

```text
storyboard
storyboarding
infinite-canvas
node-editor
local-first
desktop-app
ai-tool
ai-agent
image-generation
video-generation
tauri
react
typescript
rust
threejs
```

## About 设置建议

- **Website**：填最新 Release 页面 `https://github.com/ganbo-gab/open-storyboard-canvas/releases/latest`（或后续项目主页）
- **Releases**：开启
- **Packages**：暂时不需要
- **Issues**：开启，用于 Bug、协议兼容与需求反馈
- **Discussions**：建议开启，方便沉淀工作流案例、提示词与中转渠道配置经验
- **Wiki**：暂时不需要，优先维护 `README.md`、`README.en.md` 和 `docs/`
- **Security policy**：开启，并使用仓库根目录 `SECURITY.md`
- **Social Preview**：已准备 `1280×640` 封面图 [`docs/brand/social-preview.png`](../brand/social-preview.png)，在仓库 `Settings → General → Social preview` 上传即可，显著提升在 GitHub 推荐流、X/Twitter、Reddit、Linux Do 等渠道转发时的点击率

## 发布前检查

- `README.md` 与 `README.en.md` 已包含项目定位、核心功能、首屏演示、快速开始、技术栈、边界说明、更新日志、贡献与安全声明，且首屏无广告或赞助信息。
- `LICENSE`、`NOTICE`、`CONTRIBUTING.md`、`SECURITY.md` 已存在。
- 原作者「痕继痕迹 / henjicc」、原项目链接和授权截图路径保留：
  - <https://github.com/henjicc/Storyboard-Copilot>
  - `docs/legal/upstream-author-authorization-2026-05-31.jpg`
- 品牌图标保留在 `docs/brand/` 和 Tauri icon 目录。
- Release 页面附上安装包、系统要求、WebView2 与 macOS 临时签名/钥匙串提示。
- 发布前确认仓库中没有真实 API Key、本地数据库、未公开素材、客户资料或个人路径。

## 当前 README 媒体素材（`docs/imgs/readme/current/`）

- `stage-canvas.gif`：首屏主视觉演示——三维预演台播放走位、四视图取景并回流节点画布。
- `stage-agent-user-test.png`：2026-11-07 舞台 Agent 实测截图（建筑场景、双人相遇、15 秒时间轴与镜头编排）。
- `channels-models.gif`：渠道与模型广场筛选、视图切换与参数查看。
- `workbench-trace.gif`：生成工作台输入、批量结果与提交详情追溯。
- `agent-approval.gif`：Agent 审批卡与批准/拒绝流程。
- `canvas-tools-repaired.gif`：画布编辑菜单自定义与创作节点分组。
- `workspace-width-project.gif`：拖宽侧栏、双击复位与项目归属。
- 静态截图：`channels.png`、`models.png`、`workbench.png`、`agent.png`、`stage.png`、`viewer.png`。
