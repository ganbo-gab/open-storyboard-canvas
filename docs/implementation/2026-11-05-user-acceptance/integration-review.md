# 最终独立集成审查与修复

2026-11-05。复用现有实现，仅修复主任务已确认授权的两项实际缺陷。未改样式、布局、Git 索引，未占用浏览器或原生窗口，未进行真实模型/上传调用。

## 1. 同渠道多模型的协议投影串用

**根因：** `projectChannelProviders` 原先在整个 chat 渠道找首个模型的 operation/template/protocol，再把同一协议和工具/流式 wire 能力投影给所有模型。新的模板接入允许同一渠道各模型选择不同实际接口；例如首个为 OpenAI Chat、后一个为 Anthropic Messages 时，后者得到错误 agentProtocol，Gateway 协议预检会拒绝。

**修复：** 每个模型独立解析有效 chat mode/endpoint/template，独立投影协议、工具和流式 wire 能力。保留显式 false、上下文和输出窗口声明；非 mode 的 legacy operations 同样保留。provider 级 endpoint 仅作原有首模型概要，模型权威信息在 modelMetadata。

**回归：** 单渠道同时包含 Chat Completions、Messages、Responses；协议、流式、显式禁工具/视觉和 token 窗口均正确。反转模型顺序后，所有模型 metadata 保持相同。

## 2. 原生图片粘贴与异步会话生命周期

**根因：** native paste 原先等 `readSystemClipboard/loadImage` 完成后才进入 attaching；读取期间仍可发送或切换会话，迟到附件会调用旧回调。文本路径粘贴先读取全局剪贴板，若全局当时有另一张图片，会错误选中那张。React state 的 attaching 也不能同步阻止同一帧重复事件。

**修复：**

- `AgentComposer` 在任何异步读取之前设置同步 ref busy，包住读取→附加的整个过程；同一帧重复 paste/drop 和 Enter/点击发送不会穿过。
- 本次 paste event 的图片文件优先；只有文本明确为本地图片路径时直接读取该路径，不查询全局另一张图片；无图片、无文本时才使用 native clipboard fallback。
- composer 卸载会使其 epoch 失效，迟到读取结果不再调用附件回调。Scoped panel 用 scope/project/session/draft epoch 作为 composer owner key；会话切换替换 composer，清理旧 busy 状态。
- 原生读取 busy 回传 Scoped panel，阻止读取尚未结束就换会话；文件保存阶段另有 owner/session/mounted 检查，源准备、入库前后逐步核对，切项目/卸载后的结果不追加，已成功保存的真实 asset 不删除。
- 上传与发送准备使用同步门闩，避免读取/mention准备期间重复提交。键盘和点击发送均尊重附件读取 busy。
- 未改任何 CSS、视觉位置或组件布局。

**回归：** text-only path不读全局图；截图 event image优先；空文本native回退；异步期间重复粘贴和同帧Enter只读一次；会话composer被替换后不附旧图；重复文件选择只入库一次；入库途中换项目后不附旧素材；正常上传后显示附件，并按真实已登记assetId发送一次。

## 审查范围与边界

本轮也读取了 ChannelTemplateConnection/Browser、ModelCapabilitiesFields、ComfyConfigurationAssistant 应用/UI、workspacePreferences/ToolbarPreferencesDialog、SelectedNodeOverlay 测量与关闭逻辑。后续按主任务收敛指令，仅实施上述两项已确认缺陷。没有把代码阅读当作这些界面的真实视觉/原生验收；桌面缩放、布局位置、stage resize、真实供应商和打包仍由主任务验收。

## 检查结果

- 核心 3 文件目标回归：channelStore、AgentComposer、ScopedAgentPanel 原 20 项通过。
- 关联复核：channelStore、channelPersistence、AgentComposer、ScopedAgentPanel、comfyConfigurationAssistant、workspacePreferences 共 6 文件、26 项通过。
- 补充正常上传→发送回归后 ScopedAgentPanel 6 项通过，以上去重覆盖总 27 项。
- `npx tsc --noEmit` 最终通过。

SelectedNodeOverlay 没有同名测试文件，此次命令未为它产生执行结果；其最终交互/视觉结论需要主任务原生走查。

## 追加：Windows 窗口控制独立审查

范围限定为 TitleBar/windowControls、对应测试和本报告。Mac 原生 traffic lights、Rust macOS Overlay titlebar 配置和样式均未改动；主任务已有的 Mac native green/zoom/restore/Ctrl-Cmd-F/双击实际验收不由模拟测试替代。

发现并修复：

- 初始窗口状态查询、onResized 与动作完成后的查询可并发，旧查询迟到会把最新最大化/全屏状态覆盖。现在共用递增查询 epoch，只有最新结果可以更新控件；卸载使未完成查询失效，已停用的 resize listener 不再重新查询。监听注册失败也被显式接住。
- fullscreen=true、maximized=false 时按钮原先显示“最大化”，实际动作会退出 fullscreen；现在标签和图标统一显示可还原状态。
- 标题栏空白区的鼠标拖动/双击排除控件扩充到 textarea、select、链接和 role=button，保留 button/input/data-no-drag。第二次双击 mousedown 不发起拖动。
- F11/Ctrl-Cmd-F 保留原绑定；重复 keydown 和已被其他处理器消费的键不会再次切换。

代码与配置核对：默认 main capability 明确授权 minimize/maximize/unmaximize/close/is-maximized/start-dragging/is-fullscreen/set-fullscreen；`core:default → core:event:default` 包含 listen/unlisten，覆盖 onResized。tauri main 配置为可调整尺寸、非全屏、无 decorations，非 Mac 构建直接使用该配置；Mac 构建另行启用原生 decorations + Overlay + hidden_title。无需新增 capability 或改变配置。

验证：

```text
npx vitest run src/components/windowControls.test.ts src/components/TitleBar.test.tsx src/components/TitleBar.behavior.test.tsx --pool=forks --maxWorkers=2
npx tsc --noEmit
```

3 文件、11 项通过，TypeScript 检查通过。行为测试模拟 Windows native window API、真实 DOM 点击/双击/F11 与 resize 回调，覆盖最大化/还原、外部状态变化、全屏进出及标签、重复按键、连续点击门闩、失败后可重试、旧查询迟到、卸载移除事件以及交互控件不触发拖动/最大化。

**边界：没有 Windows 实机。** 以上证明 JavaScript 事件/状态与 Tauri 权限声明一致，不证明 Windows 窗口管理器的实际动画、Snap、DPI、多显示器、拖动捕获或原生双击派发已实测。主任务的 Mac 实测结论保留，Windows 交付仍标明代码与模拟验证。

## 追加：参数面板对象值、时长滑条与嵌套选择

新增真实 DOM 交互回归，检查 ComposerParameterPanel 的按钮/select、18 项 duration 滑条与精确值选择器，以及 PopoverSurface 内 portal UiSelect 的鼠标/键盘关闭行为。

发现并修复一个参数链真实缺陷：对象 enum 原用 JSON.stringify 比较。保存/导入的 `{ height: 720, width: 1280 }` 与声明的 `{ width: 1280, height: 720 }` 内容相同，只因字段顺序不同就失去选中态、摘要 label 为空，并且 domain/template 的请求校验同样拒绝。新增 domain/parameterValue 的结构等价比较，parameterPresentation、ComposerParameterPanel、DeclaredParameters 和实际参数校验共同复用。保留数组顺序和数字/字符串类型差异，未把非法值宽松转成合法值；未改样式。

验证内容：

- 少量对象 enum 的按钮态、显示 label、重置默认与完整对象值提交；9 项对象 enum 的 UiSelect 同样正确。
- 18 项刻意稀疏的时长逐个 slider stop 都提交原始声明值，精确 select 与 summary 同步；精确选择反向更新 slider；numeric-string enum 始终发送字符串。
- 真实 renderRequest/renderPreview 接收字段乱序的等价对象，并生成正确的数字 duration 与字符串 resolution；把数字改成字符串仍被拒绝。
- 在父 PopoverSurface 中打开 UiSelect、pointerdown/click 其 portal option 均不关闭父弹层；第一次 Escape 仅关闭 select，第二次关闭父层。这条路径现有行为正确，没有修改菜单代码。

执行 `ComposerParameterPanel`、`parameterPresentation`、`WorkbenchComposer`、`channelDomain`、`generation/channelGateway` 共 5 文件、44 项测试通过，最终 `npx tsc --noEmit` 通过。测试只调用本地请求构建器，未发模型/生成请求。参数面板的视觉录制仍由主任务实际窗口验收。

## 追加：WebKit 画布黑屏只读复审

主任务报告的“火”隔离项目首次进入画布 AX 有节点，但截图中 canvas/chrome 全黑；打开设置再关闭或 fullscreen 后恢复。此次只读检查，没有把 CUA 截图直接当成绝对渲染证据，也没有修改 CSS。

最值得移除的非必要因素是旧 `ui-workspace-enter`（`src/index.css:2012–2014`）：它使用 `animation: ui-rise 200ms ... both`；`ui-rise`（2289–2298）从 `opacity:0; transform:translateY(6px)` 到 `opacity:1; transform:translateY(0)`。`animation-fill-mode: both` 会在动画前后保留这些合成属性，整块 Studio/Canvas 若挂上该类名，会额外创建变换/透明合成上下文，并可能与 WebKit 首帧截图/窗口 show 时序重合。对持续交互没有价值，应该移除 Canvas workspace 整体入场动画；保留局部卡片、菜单和 dock 动画即可。主任务已在当前工作树中把 App canvas wrapper 保持为普通 relative/flex 容器，我没有重复修改产品文件。

未能证明为根因的因素：

- `useCanvasPersistence` 恢复项目后只在 `requestAnimationFrame` 内调用 React Flow `setViewport`（`useCanvasPersistence.ts:127–132`），页面/窗口不可见时 rAF 可能被 WebKit 节流；它可以让节点暂时在错误 viewport，但不能解释 chrome 也全黑。
- `useDialogTransition` 的双 rAF 与 `opacity:0` 只作用于 Dialog/Modal；设置打开后恢复画面说明它可能强制产生一次重排/合成提交，但不是画布长期隐藏条件。
- App `frontend_ready` 的 Tauri 显示时序（`App.tsx:180–182`、Rust `frontend_ready`/3.5s fallback）可能与 WebKit 截图 race；fallback 能显示窗口，不能证明 webview 内容已经 paint。
- `onlyRenderVisibleElements`、图片 thumbnail pending box 和局部 `visibility:hidden` 只影响节点或控件，未发现作用于 `.studio-shell` / canvas root 的全局 hidden。
- Agent dock 的 opacity/translateX 是同级区域；BlueprintScene visibilitychange/rAF 只在导演台 3D shell 挂载时运行，当前隔离项目没有 snapshot，均不是普通画布的确定主因。

建议复验顺序：先移除整画布 `ui-workspace-enter` 并冷启动同一隔离项目；分别在窗口首次显示后立即截图、等待两帧、等待 500ms 截图。记录 WebKit console/AX 与截图是否同时黑。如果仅等待后恢复，再对比 `setViewport` 恢复 rAF 和 Tauri `frontend_ready`/窗口 show 时序；不要因为设置开关恢复就把 Dialog transition 当作画布修复。

这轮结论是代码风险审查和复验建议。没有在 CUA 中宣称已重现/修复黑屏，也没有修改产品文件。

## 追加：凭据迁移重复钥匙串探测

主任务发现正式修复包启动时反复弹出 `com.storyboard-copilot.credentials.settings`。只读链路显示两个叠加问题：

- `commitCredentialMigration` 对每个 `plan.refs` 都执行 `store.has`，即使输入已经是 SecretRef、没有任何 plaintext write，也会在每次普通 settings persist 触发钥匙串存在探测。
- `createSecretStorage.setItem` 看到旧值有 plaintext write 或 blocked 后会再次 `migrate`；钥匙串拒绝后，无关主题/布局保存也会重新触发旧迁移。

已修复且未改 Rust/SecretField UI：

- 纯 refs 的 commit 不再调用 `has`。首次显式 hydration 从 ref identity 去重后做一次 metadata probe；同 store/同 ref 的并发 probe 合并。probe 不读取 secret 值，未把 missing/locked/error 当 present；后续真实 `get`/`set` 仍按原路径读取并更新状态。
- storage 对同名并发 getItem 合并。迁移失败后 blocked storage 的普通 setItem 保留原始持久化 bytes，不重试，不覆盖用户修改，也不写新凭据；后续显式 getItem/rehydrate 作为恢复边界重新尝试。部分成功 migration 继续按既有 read-back 语义跳过已存在值。
- stale metadata probe 不能覆盖更晚的真实 get/set/delete 状态；没有 secret 值缓存。

新增回归覆盖：重复 persist 不 probe、同 refs hydration 只 probe 一次、并发 hydration 合并、拒绝后无关保存不重试、显式重新 hydration 可恢复、部分失败保持原始 bytes、缺失引用保持 missing、locked 后 metadata exists 不洗成 present、迟到 probe 不覆盖显式 set，以及原有 secret transport/read-back/persistence tests。

命令：

```text
npx vitest run src/features/secrets/secretStore.test.ts src/features/secrets/storeIntegration.test.ts src/features/secrets/transportSecrets.test.ts src/features/settings/imageHostSettings.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

4 文件、33 项凭据相关测试通过；TypeScript 检查通过。未连接真实钥匙串、未读真实凭据、未改索引或用户设置文件。

## 追加：macOS Keychain `has` 原生只读复审

本轮只读复核 `src-tauri/src/commands/secrets_macos.rs`、`secrets.rs`、HTTP secret resolution 与 Cargo target 配置；没有连接真实 Keychain、没有修改 Rust。

结论：当前 `has` 实现与“存在探测不读取凭据”的目标一致。

- 查询限定 `kSecClassGenericPassword`、既有 `com.storyboard-copilot.credentials.<namespace>` service、validated account id，并使用 `SecPreferencesDomain::User` 默认 keychain，和 keyring v1 的 User 范围保持一致。
- `kSecReturnData=false`、`kSecReturnAttributes=false`，返回指针为 null；查询不会把密码 bytes 带回 Rust/IPC，也不会把值放进 CF 对象。
- `kSecUseAuthenticationUI=kSecUseAuthenticationUIFail` 明确拒绝授权 UI；没有使用 `UISkip`，因此 locked/interaction denied 不会被伪装成 missing。
- `0` 映射 present，`errSecItemNotFound (-25300)` 映射 missing；auth/interaction/keychain locked 相关状态（-128、-25291、-25293、-25308、-25315）映射 locked，其余状态映射安全的 storage_failed。未知状态不会变成 present。
- `SecItemCopyMatching` 调用发生在 query CFDictionary 存活期间；CFArray/CFDictionary/CFString/CFNumber/CFBoolean 均由 Core Foundation wrapper 持有，未发现返回 Data 的泄漏路径。常量通过 get-rule 包装，容器在调用期间保留引用。
- `SecretVault.has` 仍经过同一互斥锁；`secret_has` 通过 `spawn_blocking` 执行。真正的 `get`、HTTP marker resolution 和 read-back 仍调用 `native_vault().get`/`resolve_required`，所以 `has=true` 不会绕过读取授权，也不等同于凭据可读取。
- Windows/Linux 未切换 backend：仍使用 keyring 的原有 get/has 映射，避免跨平台语义漂移。Cargo macOS 依赖和 capability 与当前实现一致。

边界：没有 macOS 实机 Keychain，无法验证具体用户登录钥匙串 ACL、iCloud Keychain、锁屏、Fast User Switching 或企业 MDM 策略下每个 OSStatus 的实际分布；现有合成 Rust 测试覆盖 query 不返回数据和 locked/missing 映射。正式包的重复弹窗缓解仍依赖 TS 层去重/blocked 迁移改动与实际原生安装环境联合验证。
