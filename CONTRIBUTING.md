# Contributing to Open Storyboard Canvas

感谢你愿意参与 Open Storyboard Canvas。这个项目仍在快速迭代，最有价值的贡献通常是可复现的问题、清楚的文档修正、稳定的供应商适配和不会破坏画布数据的功能改进。

## 本地开发

环境要求：

- Node.js 22.22.2+（22 LTS）、24.15+（24 LTS）或 26+；Vite 8 / Vitest 5 / jsdom 30 不再支持 Node.js 20。
- npm 10+
- Rust stable（含 Cargo）
- Tauri 2 平台依赖

首次拉起：

```bash
npm install
npx tsc --noEmit
npm run build
```

`next` 分支的前端基线为 React 19、Vite 8、TypeScript 7。组件测试使用 React DOM + Testing Library；`npm test -- --run` 默认使用最多两个 fork worker，避免大画布测试耗尽内存。
TypeScript 7 的路径别名直接使用相对 `paths`，不再配置已移除的 `baseUrl`。

需要桌面能力时再运行：

```bash
npm run tauri dev
```

涉及 Rust/Tauri 命令、SQLite、图片处理、系统能力或打包配置时，请额外运行：

```bash
cd src-tauri && cargo check
```

## 提 Issue

提交 bug 时请尽量包含：

- 操作系统、应用版本或 commit。
- 复现步骤，越短越好。
- 期望结果与实际结果。
- 相关截图或录屏。
- 控制台/日志中的关键错误。

请先移除 API Key、访问令牌、Cookie、供应商账号、个人路径、客户资料、未公开图片和可识别隐私信息。不要上传本地 `projects.db` 或完整应用数据目录，除非你已经确认其中没有敏感内容。

## 提 PR

建议流程：

1. 从最新 `main` 创建功能分支。
2. 让改动聚焦在一个问题或一个功能点。
3. UI 改动附截图或录屏；供应商/模型改动说明请求格式和错误路径；文档改动说明影响范围。
4. 提交前运行必要检查，并在 PR 描述里写明结果。
5. 不要把格式化、重命名、大范围重构和功能行为改动混在同一个 PR。

推荐检查：

```bash
npx tsc --noEmit
npm run build
git diff --check
```

可选检查：

```bash
cd src-tauri && cargo check
```

## API Key 与 Secrets

- 不要提交真实 API Key、访问令牌、Cookie、CLI 登录态、`.local` 文件、本地数据库或个人供应商配置。
- 文档和测试示例请使用 `YOUR_API_KEY`、`sk-...` 这类占位符。
- 自定义供应商的 `baseUrl`、Header 和请求体如果来自私有服务，请先脱敏。
- 如果误提交了密钥，请立即在供应商后台吊销或轮换密钥，再处理 Git 历史。

## 代码与文档约定

- 前端使用 React + TypeScript + Zustand + TailwindCSS；桌面端使用 Tauri 2 + Rust。
- 画布节点、供应商、模型、工具和持久化字段要保持类型、注册表、UI、存储和文档一致。
- 新 UI 文案需要同步中英文语言包。
- 修改公开能力时，请同步 README、相关 `docs/` 文档或 release note。
- 不要提交大型生成图片、临时备份、构建产物或本地工具目录。

## 开源 Attribution

本项目基于原项目 Storyboard-Copilot 二次开发。任何再分发、公开展示或衍生项目都需要保留：

- 原作者：痕继痕迹 / henjicc
- 原项目：<https://github.com/henjicc/Storyboard-Copilot>
- 授权说明与截图位置：[`NOTICE`](NOTICE)、[`docs/legal/upstream-author-authorization-2026-05-31.jpg`](docs/legal/upstream-author-authorization-2026-05-31.jpg)
