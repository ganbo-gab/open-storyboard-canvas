# 原生凭据读取与查询恢复修复

2026-11-05。范围为 Rust 凭据读取、HTTP 请求边界和隔离回归；前端重新授权入口、任务错误分类及原任务恢复由主任务集成。

## 缺陷与修复

原请求每次创建新的 `SecretRedactor`，继而调用系统凭据库读取。提交、两秒一次的轮询和鉴权结果下载分别读取，因此 macOS 用户选择单次允许或拒绝后，后续请求仍会重复弹授权。另一个实际缺陷是 keyring 的 macOS backend 将用户取消、认证失败及交互被禁止包装为 `PlatformFailure`，原映射统一变成 `storage_failed`，未准确暴露锁定状态。

- `SecretVault` 在原生进程内按 `SecretRef` 缓存成功授权读取的值；同一互斥锁覆盖并发读取和写后校验，首次并发读取只访问 backend 一次。
- 读取失败记录阻断状态，普通 `get` 和 HTTP 自动查询直接返回固定错误；非交互 `has` 不解除阻断。拒绝不会因轮询、metadata 存在结果或时间过去而自动重试。
- 新增并注册 `secret_retry_access(secret_ref) -> bool`，明确用于用户主动重新授权。只返回存在状态，不向 UI 返回凭据。普通 `secret_get` 保留阻断语义；用户可先重新授权再显示凭据。
- 写入或删除先失效缓存，失败后阻断；成功写入仍强制读取校验后才缓存新值。校验不一致不会回退到旧缓存。
- macOS 实际读取路径将 -128、-25291、-25293、-25308、-25315 的 `PlatformFailure` 映射成 `{ state: "locked", code: "storage_locked" }`，不序列化底层错误内容。
- 凭据闲置 15 分钟后，下次读取检查并移除过期值，返回 locked 等待明确重新授权，自动查询不重新弹窗。使用墙钟让系统睡眠计入闲置；检测时钟回拨同样保守失效。
- HTTP 提取可注入 resolver 的同一内部执行路径，生产始终使用原生 vault。测试只替换凭据来源，实际构建、请求发送、响应读取、脱敏和错误处理保持生产路径。

## 验证

`cargo test --lib commands::secrets -- --nocapture`：24 项通过。

新增凭据测试覆盖 16 次并发请求只读取一次、拒绝和 metadata 探测不自动重试、明确 retry 恢复、闲置失效、时钟回拨、成功写入读后校验、写入/删除失败不复用旧值，以及 macOS 合成 OSStatus 映射。

两条 loopback HTTP 行为回归：

1. POST 提交拿到任务 ID，POST 查询两次同一个任务，再通过返回的带凭据 URL GET 下载 SVG。凭据 backend 总读取次数为 1；响应中的真实测试凭据被还原成 SecretRef token，下载时重新解析，服务端收到正确鉴权。
2. 已受理任务连续 4 次查询遭凭据拒绝，backend 总读取次数为 1，loopback 服务端没有收到请求。显式 retry 后只恢复原 `already-accepted` 任务查询，backend 总读取次数变为 2，没有重提生成任务。

`cargo test --lib commands::http -- --nocapture`：8 项通过，覆盖响应大小限制、路由配置、请求日志范围以及三种路由的跨来源重定向拒绝与同来源保留鉴权。

没有连接真实钥匙串、修改真实凭据、读取真实用户任务库、调用付费服务、操作 1420 或 Git 索引。完整原生安装包及真实钥匙串弹窗行为仍由主任务验证。

## 安全与范围边界

缓存不写磁盘、不放进 JS 状态、不打印；进程退出后不保留。缓存状态不实现 Debug/Serialize。有效期是闲置时间，活跃查询会续期；过期淘汰在下一次 vault 读取时执行。没有新增系统锁屏事件监听，因此不宣称锁屏会即时撤销已缓存授权；外部钥匙串改值/删值同样不会即时通知此进程。应用内 set/delete 会立即失效，用户重新授权会强制读取当前值。已经构建的在途请求持有其请求所需值。

本次真实下载回归验证 HTTP GET、鉴权和响应内容；不代替前端图片落盘/资产目录导入验证，也不证明任何真实供应商已经完成或返回结果。

## 追加：任务恢复、下载和工作台状态复核

复核主任务新增的 `credential` 错误类别、TemplateAdapter、channelExecution 和工作台恢复入口后，修复以下实际遗漏：

- `credentialFailureOf` 先识别错误对象自身的 state/code，再解析字符串或 Error.message。原逻辑先取 message，会漏掉 `SecretStoreError`，把浏览器或包装 backend 的拒绝当作网络异常。覆盖全部当前原生固定凭据错误码以及 JS 的等价码；未知供应商错误仍不能获得“请求未发出”的判断。
- 模型下载的 URL、header、proxy 凭据解析错误原来被降为普通 network 错误，现在使用固定 `credential` 分类并保留安全的 vault JSON。流式聊天也保留 vault JSON，不再包成普通上游错误。参考素材构建请求时的凭据拒绝同样保留 credential 类别。
- 查询/下载重试开始时清理旧凭据错误，成功后清理 error_category，避免历史卡片在成功后仍保留授权异常。
- 下载遇到凭据拒绝，即使保存失败状态时磁盘报错，也在进程内留下 recoverable_wait、credential 与已有输出/任务 ID，防止继续卡在 materializing 并触发恢复循环。存储错误内容继续脱敏。
- 明确的 retryAccess 进入 SecretStore 同一状态修订序列；此前迟到的 has 结果不能把刚完成的授权覆盖成 missing。该操作只接收 bool，未增加 JS 明文缓存。

新增行为回归包括：提交前拒绝没有上游 ID，授权后也不会自动生成；同步响应已经给出结果但下载拒绝时保留 URL，恢复仅下载；重载暂停的 poll/download 记录没有自动请求，重新授权失败仍不请求，成功后仅查询原 taskId 或下载原 URL；工作台数据重开后保留 credential 和原任务，手动恢复成功清理失败；恢复按钮等待授权、阻止重复点击，拒绝后允许明确重试；原生流式错误分类与模型错误映射。

最终验证：

```text
npx tsc --noEmit
npx vitest run src/features/secrets/credentialFailure.test.ts src/features/secrets/secretStore.test.ts src/features/workbench/store/workbenchStore.test.ts src/features/workbench/ui/CredentialRecoveryControl.test.tsx src/features/channels/runtime/channelChat.test.ts src/features/channels/runtime/templateAdapter.test.ts src/features/channels/runtime/channelIntegration.test.ts --pool=forks --maxWorkers=2
cargo test --lib commands::model -- --nocapture
```

TypeScript 检查通过，7 文件 148 项测试通过，Rust 模型下载 12 项通过。secretStore 相邻的 storeIntegration/transportSecrets 也通过。TS 原生边界采用 mock，Rust 模型 suite 使用本地 HTTP 夹具；未执行真实付费请求、真实授权或用户数据迁移。未改 UI 样式、PromptEditor 或参数控件。
