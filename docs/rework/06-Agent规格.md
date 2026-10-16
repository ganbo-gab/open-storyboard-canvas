# 06 · Agent 规格

> 一个运行时，三个 Agent：首页 Agent、画布 Agent、舞台 Agent。外部 Agent（Codex / Claude CLI）复用同一套工具注册表，经 MCP 暴露。

## 1. 现状问题

| 问题 | 证据 |
|---|---|
| 运行时 1507 行 + 控制器 1070 行 + 审批 44KB，依赖 `@openai/agents` 再套一层多协议编解码 | `agent/infrastructure/sdkRuntime.ts`、`agentProviderCodec.ts` |
| 工具用泛化 `input: object`，模型猜字段 | LRN-20260813-001 |
| 额度/限流错误被错标到当前模型；连点产生重复回合 | LRN-20260814-001/002 |
| 只有画布 Agent；首页、导演台没有 | `agent/` 目录 |

## 2. 运行时（自研小循环，移除 `@openai/agents`）

```mermaid
sequenceDiagram
  participant UI
  participant R as Runtime
  participant M as 模型（任意 chat 渠道）
  participant G as 审批门
  participant T as 工具
  UI->>R: 用户消息 + 上下文附件
  loop 直到无工具调用或触达预算
    R->>M: messages + tools（流式）
    M-->>R: 文本增量 / 工具调用
    R->>R: zod 校验参数（失败 → 错误回填给模型，不弹审批）
    R->>G: 需审批？
    G-->>UI: 审批卡
    UI-->>G: 批准 / 拒绝 / 改参数
    R->>T: 执行
    T-->>R: 结果（结构化 + 简短文本）
  end
  R-->>UI: 回合结束（撤销组）
```

- 协议：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini；由 02 的 `chat` 操作提供，运行时只见归一化后的 `{text, toolCalls}`。
- 模型能力检查：渠道模型需声明支持工具调用，否则 Agent 入口提示更换模型。
- 单回合门：同一会话同时只有一个运行中回合；发送按钮在回合中变为「停止」。
- 预算：每回合最多 24 次工具调用、最长 10 分钟；到顶时停下并说明。
- 错误归因：错误带渠道 + 模型 + 操作三元组，展示时不猜测。
- 会话持久化：SQLite（沿用现有 `agentSessionRepository` 的表，精简字段）；消息只存文本与 assetId。

## 3. 工具注册表

```ts
interface ToolDef<I, O> {
  name: string;                       // 'canvas.node.create'
  surface: ('home' | 'canvas' | 'stage')[];
  description: string;                // 一句话 + 何时使用
  input: ZodType<I>;                  // 严格 schema，发给模型的 JSON Schema 由它生成
  risk: 'read' | 'edit' | 'paid' | 'destructive';
  run(input: I, ctx: ToolContext): Promise<O>;
  summarize(input: I): string;        // 审批卡上的一行人话
}
```

- 工具直接调用各模块的应用层命令（画布命令、舞台命令、生成执行器），**与 UI 操作走同一函数**，保证「画布能做的 Agent 都能做」且行为一致。
- 读工具返回精简视图（节点 id、类型、标题、提示词摘要、尺寸、连线），不返回图片数据；需要看图时调用 `asset.view`，以缩略图喂给视觉模型。

## 4. 三个 Agent

| | 首页 Agent | 画布 Agent | 舞台 Agent |
|---|---|---|---|
| 位置 | 首页主输入框「Agent 模式」+ 会话页 | 画布右侧栏（可拖宽，可收起） | 舞台底部输入框 + 右侧会话抽屉 |
| 典型任务 | 从一句想法到剧本/分镜清单；在工作台直接出图；建项目并铺好画布；配置渠道（02 §5.2） | 按剧本批量建分镜节点并连线；批量改提示词；整组提交生成；整理布局 | 读图/文字建场景；按描述摆人物与机位；画轨迹与机位运动；检查构图 |
| 工具 | `project.*` `asset.search/view` `generation.submit/status` `channel.fetchDoc/validate/preview` `prompt.library.*` `canvas.open(withPlan)` | `canvas.query` `node.create/update/delete/move` `edge.connect/disconnect` `group.*` `layout.arrange` `generation.submit/status` `asset.*` `view.focus` `skill.run` | `stage.query` `object.add/update/remove` `trajectory.draw` `clip.add/update` `keyframe.add` `camera.follow` `scene.draftFromImage/Text` `stage.capture` `stage.record` |
| 差异点 | 首页一句话即可产出「一份画布方案」，预览后一键在画布展开 | 操作以撤销组落地，一键撤回整回合 | `stage.capture` 把画中画渲染图回传给模型，模型能「看」构图并自我修正 |

## 5. 上下文与输入

- 画布选中节点自动以灰色附件出现在输入框上方；取消选中消失；点一下固化为正式附件。
- `@` 引用节点/资产/舞台对象；`/` 唤起 skills。
- Skills：带 frontmatter 的 Markdown（`name`、`description`、`surface`、`tools` 白名单），内置 + 用户自建；「组 → 创建为 skill」把组内节点结构与提示词模板化。

## 6. 审批与撤销

- 模式：手动 / 自动。手动：`edit` 以上都出审批卡；自动：仅 `paid` 汇总确认一次、`destructive` 每次确认。
- 审批卡：一行人话摘要 + 展开看参数 + 预计费用（渠道有价格时）+ 「批准 / 拒绝 / 改参数」；**悬停审批卡时画布上高亮受影响节点**。
- 同一回合的多个同类操作合并成一张卡（「创建 6 个图片节点并连线」）。
- 每回合 = 一个撤销组；消息卡片上有「撤回本回合」。

## 7. 外部 Agent

外部 CLI（Codex / Claude Code）经内置 MCP 服务器访问**同一工具注册表**，按 surface 暴露；风险等级与审批规则一致（外部 Agent 的 `paid`/`destructive` 调用同样在应用内弹审批卡）。连接流程与故障细节见 ComfyUI/外部 Agent 审计结论后的补充章节。

## 8. 验收

- 首页：「做一个 6 镜头的猫咪短片分镜」→ 产出画布方案 → 展开为 6 个图片节点 + 剧本文本节点并连线。
- 画布：选中组 →「把提示词都改成赛博朋克风格并生成」→ 审批卡合并为两张（改提示词、提交生成）→ 撤回本回合恢复原状。
- 舞台：上传街景图 →「两个人在路口相遇，机位跟拍左边的人」→ 场景草案 + 两个人物 + 轨迹 + 跟随机位，播放可见。
- 工具参数校验失败不弹审批卡，模型在下一步自我修正。
