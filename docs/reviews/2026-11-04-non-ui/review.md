# 非前端功能审查 · 2026-11-04

**结论：主体能力已经实现，但“除了前端其他全部完成”不成立。当前有构建阻断、桌面渠道试跑/恢复故障、舞台编辑破坏已有时序、ComfyUI 结果遗漏，以及尚未接通的功能。无需重写后端，应该先修这些明确缺陷，再做前端和整体交付验收。**

本轮只审查，未修业务代码或前端。对 976 个源码文件逐一核对 SHA-256，均与审查开始时相同；Git index 哈希也未改变。只新增本目录报告、测试证据和独立复现脚本。没有操作真实工程、1420 服务、真实 CLI 配置或 Keychain，没有调用付费供应商。

实际项目是 `/path/to/Storyboard-Copilot`；截图里的 AIGC 是旧会话启动目录。审查对象为当前未提交工作树，HEAD 为 `d5d191b6b4e82d672f835d8f30ab5cfe0eecff97`，不是只看该提交。原会话最后（2026-11-01 21:01，北京时间）已明确留下“接线与局部修正、集成联调、完整 Tauri、真实供应商/外部 CLI 验收”。详见 [历史核对](history-review.md)。

## 确认的问题

P1 表示交付前应优先修复的功能失败、数据编辑风险或构建阻断；P2 表示明确的功能不完整或局部错误。未列出仅凭猜测的安全问题。

### 1. P1：桌面端临时凭据提交和显式凭据恢复被拒绝

- 位置：[channelExecution.ts:293](/path/to/Storyboard-Copilot/src/features/channels/runtime/channelExecution.ts:293)、[ai.rs:1437](/path/to/Storyboard-Copilot/src-tauri/src/commands/ai.rs:1437)。
- TypeScript 在临时 Key 提交，以及显式传入凭据恢复原任务时，写入 `credentialSource: 'transient'`；Rust 的恢复快照白名单不接受此字段。必须先落盘才会发送 HTTP，所以请求在本地就被拒绝。
- 恢复按钮实际会显式传入凭据，因此不只影响未保存的 Key。默认使用已保存凭据、且不显式换凭据的普通图片提交不受这项影响。
- **已复现：**捕获真实 TS 提交入口构造的 JSON，交给临时源码副本中的原版 Rust validator，得到 `v2 snapshot contains an unknown root field`；去掉这个字段的控制样本通过。
- 修复：两端统一来源标记契约，Rust 严格接受合法枚举并保留来源隔离。不能直接删标记规避，否则重开可能误用旧凭据。

### 2. P1：桌面端渠道聊天试跑被另一处快照不一致阻断

- 位置：[channelExecution.ts:295](/path/to/Storyboard-Copilot/src/features/channels/runtime/channelExecution.ts:295)、[ai.rs:1447](/path/to/Storyboard-Copilot/src-tauri/src/commands/ai.rs:1447)。
- 构造快照清空了 prompt/messages/tools，却通过对象展开保留了 `chatPayload`。其中仍有原始聊天正文；Rust input 白名单拒绝它。
- **已复现：**使用正常 opaque 凭据引用，真实 TS 聊天试跑快照仍含测试正文；喂给 Rust 后得到 `v2 recovery input must not contain expanded prompts, messages, tools or media`。删除 chatPayload 的控制样本通过。
- 浏览器分支直接持久化该快照，因而也会额外保留正文。这是恢复记录最小化失效，没有发现向第三方泄露的证据。
- 影响限于渠道设置的聊天试跑等经过该任务执行器的路径；普通工作台/Agent 即时聊天另走 `submitChannelChat`，不能扩大为所有对话失效。
- 修复：用明确的恢复字段构造快照，移除临时 chatPayload；原始首次请求仍保留完整内容。不要扩大 Rust 白名单把正文保存下来。

### 3. P1：画新路线会删除区间之后的已有关键帧

- 位置：[useDirectorStudioMotion.ts:474](/path/to/Storyboard-Copilot/src/features/canvas/ui/useDirectorStudioMotion.ts:474)。
- 手工绘制路径固定使用四秒区间，但合并时只保留起点之前的帧，把后面的帧一并删掉。摄像机和人物轨迹都有此逻辑。
- **已复现：**直接挂载现有 hook，原轨道有第 0、8、10 秒关键帧，新增第 0–4 秒路径后只剩新路径帧，第 8、10 秒均消失。
- 修复：调用已有 `trajectory.set` / 区间替换命令，保留编辑区间以外的内容。此项属于调用层业务逻辑；本轮未改前端文件。

### 4. P1：缩短时长绕过已有保护，静默压缩关键帧

- 位置：[useDirectorStudioMotion.ts:413](/path/to/Storyboard-Copilot/src/features/canvas/ui/useDirectorStudioMotion.ts:413)；正确保护已在 [stageOperations.ts:269](/path/to/Storyboard-Copilot/src/features/stage/application/stageOperations.ts:269)。
- UI hook 自行改文档，将所有越界的镜头、对象、动作帧时间设为新终点，没有执行应用层的拒绝截断检查。
- **已复现：**同一份数据，StageCommands 拒绝从 12 秒缩到 5 秒；实际 hook 却保存，并把原第 8、10 秒两帧都改成第 5 秒。原始动作时序因此改变。
- 修复：时长调整复用统一命令，并明确处理超出新时长的内容，避免两套编辑语义。

### 5. P1：当前标准构建被 TypeScript 错误阻断

- 位置：[channelUiStore.ts:31](/path/to/Storyboard-Copilot/src/features/channels/application/channelUiStore.ts:31)。
- persist 初始化把 focusChannelId 推断为仅 `null`，与 `ChannelUiState` 的 `string | null` 不兼容，报 TS2345。
- **本轮执行 `tsc --noEmit` 失败。** package.json 中标准 build 是 `tsc && vite build`，因此当前不具备标准构建通过条件；没有重复跑已知会被 tsc 阻断的 build。
- 原会话已记录此半成品问题，现仍存在。属于本轮禁止修改的前端状态模块，仅登记。

### 6. P2：ComfyUI 批量结果只发布第一项

- 位置：[comfyExecution.ts:266](/path/to/Storyboard-Copilot/src/features/channels/runtime/comfyExecution.ts:266)、[comfyExecution.ts:349](/path/to/Storyboard-Copilot/src/features/channels/runtime/comfyExecution.ts:349)。
- 下载循环处理所有 outputs，但公开 DTO 只写 `result: assets[0]`，没有 results 数组；完整快照又从公开 DTO 中移除。重开也只恢复第一个 asset。
- **已用真实 localhost HTTP 复现：**一个 prompt 提交、history 返回两张不同文件、两个文件均被下载，最终业务接口仍只给一张。工作台和画布的消费者没有补偿逻辑。
- 额外产物字节可能仍在本地，但正常流程不能展示/导入；没有证据表明它自动重复收费。
- 修复：成功结果与重开水合均保留完整的 source/kind 列表，增加“一次提交、多个产物、重开后全量可用”的测试。

### 7. P2：视频裁剪参数单位不一致

- 位置：[MediaEditDialog.tsx:71](/path/to/Storyboard-Copilot/src/features/canvas/ui/MediaEditDialog.tsx:71)、[media/types.ts:56](/path/to/Storyboard-Copilot/src/features/canvas/application/media/types.ts:56)。
- 对话框按像素构造 rect，默认宽高取视频分辨率；服务却要求 0–1 归一化坐标。普通 100×100 像素裁剪会触发 invalid-range。
- 证据为当前源码调用链核对；未操作真实界面或新跑视频编码。
- 修复：在调用边界按原视频尺寸归一化，并共享单位约定；不改底层服务去猜参数单位。

### 8. P2：音频倍速控件允许服务拒绝的值

- 位置：[MediaEditDialog.tsx:185](/path/to/Storyboard-Copilot/src/features/canvas/ui/MediaEditDialog.tsx:185)、[media/types.ts:68](/path/to/Storyboard-Copilot/src/features/canvas/application/media/types.ts:68)。
- 控件允许 0.25–4 倍，服务仅接受 0.5–2 倍。因此部分界面合法值执行失败。
- 静态调用链确认；本轮未改控件。修复时从同一能力定义读取范围，或先真正实现扩展范围。

### 9. P2／未完功能：ComfyUI 实时节点和采样进度未接入

- 位置：[comfyExecution.ts:164](/path/to/Storyboard-Copilot/src/features/channels/runtime/comfyExecution.ts:164)、[adapter.ts:134](/path/to/Storyboard-Copilot/src/features/channels/adapters/comfyui/adapter.ts:134)。
- adapter 有 WebSocket 分支和测试，但生产依赖没有传入 ws；提交与轮询还各建一个 adapter，无法共享闭包内的 socket 状态；运行层只保存 last_poll_at，丢弃 pending.progress/message。
- 因此只有 history 轮询，不能声称已支持真实当前节点/采样步数。规格 07 第 38 行与原会话缺口记录要求此能力。
- 修复要同时处理连接注入、同一任务的 adapter 生命周期和进度状态发布，并保留断线后的原任务轮询。仅新增百分比界面不能完成此功能。

## 本轮验证结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 当前完整 Vitest | 233 文件，2306 测试通过 | [tests.log](tests.log) |
| 当前 TypeScript | 失败，channelUiStore TS2345 | [typecheck.log](typecheck.log) |
| Rust library check | 通过，locked/offline | [cargo-check.log](cargo-check.log) |
| 当前完整 Rust lib tests | 197 通过 | [native-tests.log](native-tests.log) |
| 新增定向行为复现 | 3 个缺陷断言失败：Comfy 批次、舞台时长、舞台路径 | [behavior-probes.log](behavior-probes.log) |
| 实际 TS 快照捕获/最小化 | 捕获成功；聊天正文仍存在的断言失败 | [snapshot-probes.log](snapshot-probes.log) |
| 实际 TS 快照 → 原版 Rust validator | 2 个契约断言失败；各自去掉问题字段的控制样本通过 | [native-cross-language-probes.log](native-cross-language-probes.log) |
| 源码与暂存区保护 | 976 文件均未改变，index 未改变 | [integrity-check.json](integrity-check.json) |

复现失败用于证明缺陷，不是工具环境失败，也没有通过修改产品代码把它们改绿。`.probe.ts` 和独立配置不会进入项目默认 `*.test.ts` 测试集合。运行方式（项目根目录）：

```sh
./node_modules/.bin/vitest run --config docs/reviews/2026-11-04-non-ui/vitest.review.config.mts
python3 docs/reviews/2026-11-04-non-ui/reproduce-native.py
```

原生复现脚本复制 src-tauri 到临时目录，只在副本中注入断言；使用实际 TS 生成的 JSON，不以 mock 接受结果代替 Rust 校验。源码副本和日志保留便于复核。

## 功能完整性判断

| 模块 | 本轮可支持的结论 | 仍未闭环 |
|---|---|---|
| 三 Agent、审批、取消、撤销 | 已有实现与大量单测，历史有隔离实际行为证据 | 真实模型多轮效果、真实外部 CLI 与桌面整体流程未验收 |
| 渠道提交、恢复与凭据 | 主体已实现，现有测试覆盖较多 | 本报告两处 TS/Rust 快照不一致；真实供应商验收 |
| 画布/舞台命令 | 原子命令、保护、撤销等已实现 | 部分实际操作绕过这些命令；时序损坏问题需修 |
| 媒体处理 | 核心操作有测试，历史有重新解码产物证据 | 裁剪/倍速实际参数接线；原生 WebKit 全路径 |
| ComfyUI | 提交、history、原任务切换连接等已实现 | 多产物公开与重开；实时节点进度；真实 GPU/自定义节点验收 |
| 项目/资产/知识库持久化 | 当前回归通过，知识库原生边界有测试 | 全画布统一 assetId 迁移明确未完；Windows 文件边界实际运行未验收 |
| 千节点日常性能 | 历史已验证正常视野平移/缩放、最多拖 10 节点 | 本轮未重测，不扩大为原生/全平台/fit-all 压力通过 |
| 当前交付集成 | 前端继续暂停，现有业务源码保留 | 标准构建未通过，完整 Tauri/Keychain/供应商/CLI 验收仍需单列 |

没有按文件数量估算“完成百分比”，也没有把旧完成声明当当前全路径保证。本轮为重点功能审查和隔离复现，不声称穷尽所有交互组合。

## 优化顺序

1. **先统一跨层契约。** TS 生成的真实快照应直接通过 Rust 校验测试；减少两边分别手写字段白名单。当前 native IPC 全成功的 mock 正好掩盖了两项桌面故障。
2. **所有编辑入口复用统一业务命令。** 舞台 hook 直接修改 document 和 StageCommands 并存，是“服务测试通过但用户操作出错”的根因。先收口行为，再拆文件；不必重写渲染层。
3. **补任务恢复和结果清单的端到端测试。** 重点是多产物、重开、换凭据、取消后的迟到结果、存储失败；每个场景核对提交次数，避免把查询恢复改成新生成。
4. **再优化任务存储和资源寿命。** 浏览器生成记录目前每次轮询读取/序列化整个 localStorage 历史；任务增加后可迁到按条 IndexedDB，并合并纯进度写入。blob URL 与内存任务表应定义清理时机。本轮没有量化其性能收益，也未认定已经发生内存泄漏。
5. **建立单一验收矩阵。** 每项分清“实现、用户入口、隔离验证、原生验证、真实供应商验证”。历史文档混有不同时间点的“已完成/待完成”，容易再次误判。

建议下一阶段优先处理快照契约和 ComfyUI 非视觉结果链，再处理涉及前端调用文件的时序/媒体接线，最后做外观与整体验收。本轮未实施任何这些修复。
