# 验收更正：单行输入栏与 Mac 更新授权

2026-11-09 用户安装 0.2.2-preview.1 后指出摄像机换行不符合要求，并报告生成、Agent 首次调用都需要钥匙串确认。后续用户明确：选择“始终允许”后，每条凭据只弹一次，同一版本连续调用不再弹。

## 查明的根因

- `v0.1.27` 没有 `src/features/secrets` 和原生 `commands/secrets.rs`，系统凭据存储是在 v0.2.0 大更新提交 `3487f84` 中引入的。旧版主要读取普通配置，不存在同一套系统访问检查。
- 只读核实当前安装应用为 0.2.2-preview.1，identifier 为 `com.ganbo-gab.open-storyboard-canvas`，签名为 ad-hoc，designated requirement 是 `cdhash H"4a4f8db3052f28b6e7ad8b477acd96f5bb0f5b96"`。
- 只读挂载正式 v0.2.1 安装包，identifier 相同，但 arm64 指定要求是 `cdhash H"873630088fe7fec2d6c84f24b1f33757c0f29919"`。镜像已卸载。
- `.github/workflows/build.yml` 原先对正式 Mac 包也固定设置 `APPLE_SIGNING_IDENTITY="-"`，不是仅本地预览包的问题。应用标识和数据路径不变，不能保证 Keychain 的代码身份匹配。
- 原生后端使用传统 login Keychain，每个 namespace/id 是单独条目，访问权限逐条管理。生成与内置 Agent 在同一渠道下共用同一 ref 和进程缓存，没有发现 Agent 额外复制一套 Key；不同渠道则可能分别询问。
- 本机代码签名身份清单为 0，仓库 Actions secrets 清单为空。尚无可用于实际稳定签名的证书。

主线另用两个临时小程序实际复现：相同 identifier，分别临时签名后，第一个程序的指定要求接受旧程序、拒绝更新程序。只检查签名要求，没有创建钥匙串、读取用户凭据或修改系统搜索列表。证据见 [签名连续性复现](signature-continuity.json)。

上次移除 15 分钟误锁等修复仍对应真实代码缺陷，但没有覆盖跨版本身份连续性。29 项隔离后端回归不能作为真实更新后不弹窗的证明；“可能询问一次”也不够准确，应区分每条凭据。

## 本轮完成

1. 输入栏恢复单行。模型/模式/参数文字平均分配可用宽度并省略，摄像机保留完整文字，数量和发送保持独立固定区域。没有把摄像机推入第二行。
2. 发布签名支持稳定证书，正式 tag/Release 缺稳定身份就明确阻止，不能静默退回临时签名；开发包可明确接受 ad-hoc 限制。
3. 签名校验检查固定 identifier、资源完整性、各架构指定要求及其证书绑定，不把普通 `codesign --verify` 通过当作更新身份连续。
4. README 与[签名配置文档](../../release/macos-signing.md)准确说明旧版差异、逐条确认、固定签名和首次转换边界。

验证：75 项相关前端回归、TypeScript、生产构建通过；7 项签名策略/校验测试及 workflow YAML 解析通过。Ego 独立工作区 30 实际验证 1200px/960px 窗口及 158% 画布缩放下所有输入栏按钮中心线一致、未溢出；摄像机入口正常打开独立窗口。截图：[单行长名称](screenshots/single-row-long.png)、[960px 窗口](screenshots/single-row-960.png)、[158% 缩放](screenshots/single-row-158.png)。浏览器验收工作区已完成关闭，1542 临时服务停止。

唯一辅助代理按用户要求使用 GPT-6 Astra，负责签名审查与实现；本轮没有恢复旧 Sol 子代理任务。

## 尚未完成

稳定签名构建的代码和说明已准备，但实际长期身份尚未选定/配置。用户对方案询问回复的是平台行为问题，不能视为授权创建证书。没有创建身份、导入钥匙串、设置 GitHub secrets、重新安装软件或发布新包。

可选 Developer ID Application，或维护者长期保管的固定自签名证书。后者仍未获 Apple 公证；不能每次构建重新生成证书。首次从旧 ad-hoc 切换到固定证书，旧条目仍可能分别需要确认，之后使用兼容身份才具备正常升级延续授权的条件。尚未进行两个真实稳定签名安装包的系统授权升级实测。

Windows 不使用这套 Mac 代码签名 Keychain ACL，不能把本次 Mac 现象套到 Windows；同时也不能保证 Windows 登录会话、凭据损坏等系统故障永远不会发生。
