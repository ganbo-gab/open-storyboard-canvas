# 自定义图床与内置服务退役验收（2026-11-05）

已移除 PiXhost、seedvault 的可执行内置适配、默认外部上传域名和邮箱密码换 token 登录流程。图床现在只接受用户自己配置的完整 POST 上传地址；默认关闭、地址为空。

## 实现

- `features/settings/imageHostSettings.ts` 统一定义 Zod v2 配置、有效性检查、旧配置迁移与存储前置退役。设置 store 复用此定义，减少原大文件中的图床分支。
- `ImageHostSection` 替换两组内置服务表单。用户按服务文档填写完整上传 URL、multipart 图片文件字段、响应 URL 的 JSON 路径，以及可选请求头；请求头值使用既有 `SecretField`，明确启用后保存。默认不会联络任何外部服务，没有登录和测试上传副作用。
- 通用上传器只 POST 到精确配置的地址，按配置解析响应字段。支持 `data.url`、`data.images[0].url`、`$.data.url`；不猜测备用 URL 字段、不自动重试。错误地址、缺失字段、保留 multipart 头、无效响应在相应边界明确报错。
- 新请求头值通过既有 `protectCredentials` 保存到 `image-host/custom` 作用域，普通 store/持久 JSON 只保留 SecretRef marker。发送保持 marker 直达既有原生 HTTP transport，Rust 在 `build_http_request` 内解析凭据后才调用 send；缺失/锁定凭据不会被当成真实字符串发送。
- 旧设置的两种 provider 全部迁为 disabled。内置地址不会变成新的可用上传端点；真正自定义地址保留为待核对的关闭草稿，保留原 endpoint 的可读记录。旧邮箱、密码、token 不迁入新的运行配置，不再触发自动登录。
- 在通用保险库迁移前先清理旧图床登录配置，因此旧密码/token 不会被再次迁入保险库；已有保险库条目不删除。旧 URL 中的账号、查询参数和片段不进入可读草稿。
- 同版本 hydration、旧版本 migration 和设置文件导入均覆盖。导入的新旧图床一律 disabled；所有请求头只允许安全引用进入导入/导出配置，未识别名称的明文 header 也不能混入导出。
- 旧素材 URL 保持原样，不删除或重上传。修复旧视频网关 `requireImageHost` 自动上传分支：本地素材在发送和调试预览时均返回 `reference.needsPublicUrl`，用户明确确认的 `referenceHosting` 操作成为唯一上传入口。
- 更新 Agent 图床诊断为 custom/configured 元数据，避免保留旧 provider 字段。

## 验证

执行：

```text
npx vitest run src/components/settings/ImageHostSection.test.tsx src/features/settings/imageHostSettings.test.ts src/features/canvas/application/imageHosting.test.ts src/features/channels/application/referenceHosting.test.ts src/features/portability/application/settingsPortability.test.ts src/features/secrets/storeIntegration.test.ts src/stores/settingsStore.test.ts src/features/canvas/application/generation/generation.test.ts src/features/canvas/application/generation/channelGateway.test.ts src/features/workbench/application/workspaceDocument.test.ts --pool=forks --maxWorkers=2
npx tsc --noEmit
```

结果：10 个文件、123 项通过；随后新增 3 项有意义回归，重跑关联的 `settingsPortability` 与 `channelGateway` 共 38 项通过，累计去重覆盖 126 项。最终 TypeScript 检查通过。

回归包括：空默认配置、同版本重启与迁移不复活旧服务、自定义旧地址保持关闭、旧密码在进入保险库迁移前去除、保存 header 后普通状态无明文、URL/字段/响应路径校验、仅指定字段取 URL、失败不重试、现有素材不重上传、旧视频发送及预览不自动上传、导入的真实自定义接口也必须重新启用，以及设置表单添加/删除凭据头和明确开关行为。

源代码复核：旧服务域名仅保留在迁移识别逻辑中；生产上传器只有已确认参考上传调用方。`workspacePreferences` 与 `WorkspaceLayoutSettings` 并发改动保留。

## 边界

本次测试使用隔离配置、内存保险库和模拟 HTTP，未触碰用户真实 Keychain、真实媒体、1420 服务或 Git 索引，未联络或付费调用任何图床。完成了实现与行为验收；最终设置页在真实窗口中的视觉走查及原生自定义服务接入由主任务集成验收。没有重打原生包。
