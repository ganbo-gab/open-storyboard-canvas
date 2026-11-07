# 原生渠道快照契约修复

2026-11-06。范围：`src-tauri/src/commands/ai.rs`、新的 Rust 契约测试、TypeScript fixture 生成脚本及 JSON 夹具。未改 Agent codec、JS UI、真实数据库、钥匙串或 Git 索引；没有供应商请求。

## 根因与影响

前端 `ModelSpec` 已支持 `capabilities`，且模型能力预设会给已知模型填入此字段。Rust 的 `validate_snapshot_profile` 仍使用旧模型字段白名单，因而报 `model declaration contains an unknown field: capabilities`。`ParamSpec.display` 也没有加入 Rust 参数字段白名单，基础参数及模式参数均会失败。

`submitChannelJob` 先等待本地 `create_generation_job`，成功后才进入 HTTP 提交。因此由此验证错误中断的当前尝试停在付费请求发送之前。它不等同于曾被上游受理的其他任务失败，不能据此自动重提已有任务。

同一个 validator 也被原生历史行清理与读取调用。旧的 `sensitive_fields_scrubbed=0` 行若含这两个合法字段，之前会被判为不可保存并清空 descriptor。本次修复可防止后续误拒绝；已被旧版本清空的 descriptor 不会凭空恢复。此轮未读取或修改用户数据库，也未断言实际已有行被清空。

## 字段对照与实现

| 层级 | 核对结果 |
|---|---|
| ChannelProfileV2 | version/id/name/baseUrl/auth/headers/docsUrl/notes/operations/models 一致；保留 URL 与敏感 header 限制 |
| ModelSpec | 新增 capabilities 白名单项；其余 id/label/operations/params/refs/mention/modes 一致 |
| capabilities | 严格只接受 contextWindow、maxOutputTokens、supportsMultimodal、supportsTools、supportsStreaming；前两项为正安全整数，后三项为 boolean；字段可省略、空对象合法；null、字符串、未知字段不合法 |
| ParamSpec | 新增 display，仅接受 auto/buttons/select/slider/hidden；基础和 mode.params 共用同一验证器；其余字段一致 |
| ModeSpec / RefSlot / refs | 字段、枚举、唯一性、上下限与模式 endpoint 校验一致 |
| OperationSpec | method/path/body/template/files/imageEncoding/response/errorPath 一致；multipart/files 互斥规则保留 |
| response / poll / resultRequest / OutputSpec | 字段与分支一致；model 输出要求、auth:boolean、声明模板变量与参数/槽位引用校验保留 |
| 模板恢复输入 | 允许 jobId/channelId/modelId/modeId/operation/prompt/params/refs/count；prompt 必须空、refs 必须空；messages/tools/toolChoice/chatPayload 是临时输入，明确不写恢复快照 |
| 模板快照外围 | 保留 version/adapter/credentialSource/profile/input/submit/assets/assetKinds/outputs/failure 精确名单；补 input.count 为有限 number、submit 为对象、assets 为 string[] 的类型检查 |

没有使用开放 passthrough、没有剥掉能力或展示元数据来“绕过”验证。既有敏感字段、明文 credential assignment、data URL、blob URL、过长/过深数据、模型/模式错配仍被拒绝。

ComfyUI 使用独立 `comfySnapshot.ts` 合同，不包含本次 ModelSpec 字段。审查发现其 Rust 内层历史验证目前只要求 workflow/bindings/urls 为对象并严格验证 auth/recoveryRoute，没有逐项复刻该 TS 内层 schema。此轮保留已有 ComfyUI 兼容边界，未在修复 capabilities 时大幅收紧历史 ComfyUI 行；这属于现存验证覆盖差异，未宣称所有 ComfyUI 内层已完全同构。共用 count/assets 类型校验覆盖 ComfyUI 合法现状，已有 Comfy 恢复回归继续通过。

## 跨语言与恢复验证

`scripts/generate-native-channel-contract.mjs` 直接导入实际 TypeScript `channelProfileSchema`、`openAIStandardProfile` 和 `applyModelCapabilityPreset`，不导入 stores、不读取配置、不调用网络。用 Node 24 自带类型擦除执行，未增加依赖。

夹具包含：

- 已知 `deepseek-v4.1-flash` 模型能力预设经真实 TS schema 验证的完整 profile；
- 含所有能力字段、五种 display、mode endpoint、slots、异步 poll/resultRequest、输出与恢复元数据的完整 profile；
- 合法空 capabilities；
- 55 个经 TS schema 实际拒绝的能力类型、display 和各声明层未知字段变体。

Rust 直接消费相同 JSON，分别走真实 admission、临时 SQLite 写入、关闭重开、启动清理与 DTO 读取。覆盖 sensitive_fields_scrubbed 为 0/1 的两种行，逐字段比较 descriptor，确认原上游任务编号和 submit_attempts=1 保留。

另覆盖新元数据周边的明文凭据、URL token、媒体数据及 runtime 字段类型错误拒绝。夹具记录 `profile.ts` 的 SHA256；前端 schema 下次变化时 Rust 测试会失败，要求重新生成夹具并复核原生契约，而不是静默漂移。`--check` 还会对比最新实际 preset 生成结果。

```text
node scripts/generate-native-channel-contract.mjs --check
cargo test --lib commands::ai -- --nocapture
npx vitest run src/features/channels/domain/channelDomain.test.ts src/features/channels/application/modelCapabilityPresets.test.ts src/features/channels/runtime/templateAdapter.test.ts --pool=forks --maxWorkers=2
```

结果：fixture current（3 个合法 profile，55 个非法变体）；Rust 41 项通过；TS 3 文件 47 项通过；范围内 diff 空白检查通过。没有执行新的 Tauri 安装包试运行或 DeepSeek 实际调用，相关端到端供应商验证由主任务负责。
