# Mac 更新与稳定签名

Mac 安装包必须保持稳定的代码签名身份，才能让钥匙串辨认它是之前获准访问凭据的应用。`CFBundleIdentifier` 保持为 `com.ganbo-gab.open-storyboard-canvas` 只保留应用标识与数据目录，并不能单独保留钥匙串授权。

## 已确认的问题

v0.2.1 发布工作流曾固定设置 `APPLE_SIGNING_IDENTITY="-"`。这属于 ad-hoc 签名；实际 v0.2.1 与本轮 v0.2.2-preview.1 的 designated requirement 都是各自不同的 `cdhash`。二进制更新后，旧条目的访问规则不再匹配新程序，因而会再次请求允许。签名完整性检查通过不等于更新身份连续。

现有 Key 使用 login Keychain 的独立 generic-password 条目，service 为 `com.storyboard-copilot.credentials.<namespace>`，account 为凭据 ref 的 id。每个条目有自己的访问权限。同一渠道的生成与内置 Agent 共用引用和进程缓存；不同渠道可能分别提示。用户选择“始终允许”后，同一版本、同一条目不应由应用的闲置时间再次要求授权。

应用配置、画布与凭据值可以完整保留，同时旧条目的访问权限仍需要重新确认。更换一次稳定证书不能让新程序绕过旧 ad-hoc 程序的访问规则：**旧条目首次被新签名访问时仍可能分别需要系统允许**。后续使用同一稳定身份和兼容 designated requirement 的版本，才具备保留授权的条件。钥匙串被锁、条目权限被修改、证书身份变化等系统状态仍可能要求交互；不能承诺任何情况下永久零弹窗。

## 选择与保管身份

- **Developer ID Application**：面向公开分发的推荐路径。长期由同一 Apple Developer Team 管理，保留应用标识和兼容的签名要求。签名与 Apple 公证是不同步骤，本工作流的签名检查不宣称已公证。
- **维护者固定的自签名代码签名证书**：可提供钥匙串需要的稳定证书身份，不要求先取得 Developer ID；不能因此宣称通过 Gatekeeper 或 Apple 公证。必须长期保存同一私钥、证书及其受保护备份，并在本地与 CI 使用同一身份。每次构建重新生成证书会再次破坏连续性。
- **Ad-hoc**：开发验收包须明确选择；发行包默认禁止，维护者可在手动发布工作流中单独选择临时签名例外。此类发行包未公证，更新后每条已保存凭据都可能再次要求授权，不能称为稳定签名发行。

不要用仅匹配 bundle identifier、路径或“允许任何应用”的访问规则代替证书身份，也不要为解决提示批量改写用户条目 ACL。把主密钥存入普通本地文件会削弱同用户进程之间的保护；把主密钥继续存入钥匙串则仍需稳定签名。合并为单一加密库也不能免去读取旧条目时的权限确认，因此不是本问题的最小修复。

## GitHub Actions 配置

由维护者在仓库 Actions secrets 中配置以下三个值；本次代码变更不创建证书、不导入本机钥匙串、不写入任何 GitHub secret：

| Secret | 内容 |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | 已选定且长期维护的代码签名身份名称（例如 Developer ID Application 证书名称，或固定自签名证书名称） |
| `APPLE_CERTIFICATE` | 同一身份的 PKCS#12（`.p12`，含私钥）文件的 Base64 内容 |
| `APPLE_CERTIFICATE_PASSWORD` | 保护该 `.p12` 的非空密码 |

证书和密码必须成对提供；若本地签名身份已经安装，可同时省略这两个变量。Tauri 按官方机制导入 CI 证书并签名；脚本不自行创建或更换证书。证书与密码不要写入源码、构建参数、日志或安装包。

`build.yml` 在编译之前检查身份：tag 构建、填写 `release_tag` 的手动构建默认要求稳定身份，缺少证书不会自动退回 ad-hoc。开发变量 `MACOS_ALLOW_ADHOC=1` 不能覆盖正式发布策略。

维护者暂缓配置长期身份、明确接受临时签名发行时，可手动运行 `workflow_dispatch`，填写 `release_tag` 并主动勾选 `macos_adhoc`。只有该手动输入会给检查、构建和校验步骤传入独立的 `MACOS_ALLOW_ADHOC_RELEASE=1`；脚本同时要求事件是 `workflow_dispatch`。默认 tag push 没有该例外，仍会拒绝临时签名。日志明确记录维护者选择了未公证的 ad-hoc 发行，并提示更新时可能逐条重新授权。发行说明也必须披露此限制，不能承诺更新后零弹窗。

不填写 `release_tag` 的开发构建，在没有稳定身份时仍须主动勾选 `macos_adhoc`。若已经配置稳定 `APPLE_SIGNING_IDENTITY`，无论是否选择临时签名例外，都优先使用稳定身份。证书与密码不成对、证书与身份不符或签名产物不符合所选策略时仍会失败，不会因例外而改用另一身份。

手动发布只需将目标代码推送到分支后启动一次工作流，无需提前推送 tag。两端构建通过、发行说明确认非空后，发布任务使用本次 `GITHUB_TOKEN` 为 `GITHUB_SHA` 创建缺失 tag；该 token 引发的 push 不会再启动第二轮构建。已有 tag 必须能解引用到同一 `GITHUB_SHA`，否则拒绝发布；不会移动已有 tag。随后保留 `gh release create --verify-tag` 检查并发布这次构建的安装包。

签名、公证与凭据迁移的权限边界相互独立。当前工作流只配置上述签名变量；如需公证，应另行按 Tauri 官方文档配置公证凭据并完成 Gatekeeper 验收，不能以本检查通过代替公证证据。

## 本地构建与校验

先在当前终端的安全环境中提供所选 `APPLE_SIGNING_IDENTITY`。以下命令不自动生成身份；有配置缺口时会直接失败。

```sh
node --test scripts/mac-signing.node-tests.mjs
MACOS_SIGNING_RELEASE=1 node scripts/mac-signing.mjs check
MACOS_SIGNING_RELEASE=1 node scripts/mac-signing.mjs build --bundles app,dmg --ci
MACOS_SIGNING_RELEASE=1 node scripts/mac-signing.mjs verify "src-tauri/target/release/bundle/macos/Open Storyboard Canvas.app"
```

`MACOS_SIGNING_RELEASE=1` 用于本地明确要求发布标准；CI 从 tag 或 `release_tag` 自动判断。环境中的 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` 如有设置会原样交给 Tauri，不打印其内容。

明确接受开发包限制时可用：

```sh
MACOS_ALLOW_ADHOC=1 node scripts/mac-signing.mjs build --bundles app,dmg --ci
MACOS_ALLOW_ADHOC=1 node scripts/mac-signing.mjs verify "src-tauri/target/release/bundle/macos/Open Storyboard Canvas.app"
```

如设置了稳定 `APPLE_SIGNING_IDENTITY`，上述开发命令也继续使用该身份。通用包添加 `--target universal-apple-darwin`，校验路径改为 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Open Storyboard Canvas.app`。

工作流构建 `app,dmg`，保留 `.app` 供后置检查；只构建 `dmg` 时 Tauri 可能清理中间 `.app`。上传和发布仍只使用 DMG。

打包后的检查会验证 bundle 与签名 identifier、签名资源完整性、每个架构的 designated requirement。稳定签名不能包含 `cdhash`，必须绑定现有 identifier 和 Apple 团队或固定证书锚；通用包的两个架构必须使用相同的 requirement。脚本接受常规 Developer ID 与固定自签名证书的要求，未知自定义布尔规则需要单独审查，不静默放行。

这些静态检查不能证明证书私钥在未来仍被正确保管，也不能证明现有钥匙串条目已授权。正式更新验收应在独立测试用户或经授权的测试环境中，用两个不同版本、同一稳定身份、无真实供应商 Key 的测试条目，验证第一次允许、退出重开、覆盖升级、生成与 Agent 共用渠道等行为。仅运行 mock 测试不算真实系统授权验收。

## 参考

- [Apple TN2206：代码签名、designated requirement 与 Keychain 访问控制](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
- [Tauri v2：macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub Actions：GITHUB_TOKEN 事件与避免递归工作流](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)

Apple 文档说明 Keychain 用应用的 designated requirement 追踪访问身份，固定自签名身份也可以用于这类稳定性判断；Gatekeeper 的信任要求另行适用。
