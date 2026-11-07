# 本地验收包与新版 README 动图

2026-11-05，源码版本 0.2.0-next.1。

## 桌面包

使用 `npm run tauri -- build --bundles app,dmg --ci --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'` 完成 Apple Silicon release 构建。

交付目录：`/path/to/storyboard-workspace/验收包-2026-11-05/`，内含 `.app`、`.dmg`、包信息、构建日志与 SHA256SUMS。Mach-O arm64、Info.plist、ad-hoc 签名完整性、DMG 完整性和复制哈希均已检查。没有启动或安装应用；未进行本机真实窗口/供应商验收。Mach-O 最低 macOS 11，包内 plist 的旧 minimum 10.13 不代表该二进制能运行于 10.13。

## 动图

使用当前生产构建、Ego 独立 space6、127.0.0.1:15640 预览与 15641 本地模拟接口。四段 GIF 通过 CDP 连续录制实际界面变更；没有用旧截图伪造操作。

- `channels-models.gif`：我的渠道、模型广场、音频筛选、卡片/列表、模型能力与参数详情。
- `workbench-trace.gif`：输入提示词、参数面板、本地生成两份结果、提交详情。
- `agent-approval.gif`：输入创建画布请求、展示实际待审批卡。剪辑停在审批状态；实际批准及新画布创建另已观察成功，但不把未录下的画布落稳结果写成动图内容。
- `stage-canvas.gif`：预演人物路线/动作、四视图、查看器正面→右侧、发送到画布、返回后适合屏幕显示四个结果与来源连线。录制两段之间仅删去等待，未改操作顺序。

录制帧统一为 RGB 后以 10 fps 编码并优化调色板；去掉开头残留帧。README 注明本地演示/模拟接口，静态截图放入折叠区。原 `prompt-management.gif` 完整保留。

完整解码、循环标记、首尾与关键操作帧、README 本地链接检查通过；详细尺寸、时长、大小、哈希见 `media-checks.json`。独立复核确认舞台完整流程和 Agent 待审批状态与文案一致。

本轮仅修改 README 与新增演示/记录文件，未修改产品实现。Git 索引保持原 SHA256 `14ab07df3bff02d0b7759ec60f8d20c1cf9fb4efaaed6475a06906eb7794bab4`。自己的预览和模拟服务已停止，space6 已 finish；未操作用户 1420 服务、真实数据、CLI 配置或 Keychain。
