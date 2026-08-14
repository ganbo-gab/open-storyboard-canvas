export interface SkillExample {
  input: string;
  outcome: string;
}

export interface SkillDefinitionV1 {
  id: string;
  version: 1;
  summary: string;
  activation: string[];
  instructions: string;
  toolNamespaces: string[];
  examples: SkillExample[];
  evalCaseIds: string[];
  estimatedTokens: number;
}

export type AgentToolKind = 'canvas' | 'asset-read' | 'diagnostics' | 'config';

export interface AgentToolPolicy {
  mode: 'minimal' | 'local-router' | 'tool-search';
  toolKinds: AgentToolKind[];
  deferredToolKinds: AgentToolKind[];
  reason: string;
}

const SAFE_NAMESPACES = new Set([
  'canvas.read',
  'canvas.write',
  'canvas.navigate',
  'generation',
  'diagnostics',
  'config',
  'prompting',
  'director',
]);

const SHARED_SKILL_RULES = [
  '所有读取、修改、配置写入和外部提交继续受代码层审批、schema、revision 和幂等回执约束。',
  '只引用工具返回的真实 nodeId、assetId、jobId；缺少证据时明确说明未知，不伪造完成状态。',
  '不得请求或回显 API key、Authorization、Cookie、完整媒体数据或本地绝对路径。',
].join('\n');

function defineSkill(input: Omit<SkillDefinitionV1, 'version' | 'estimatedTokens'>): SkillDefinitionV1 {
  const instructions = `${input.instructions.trim()}\n${SHARED_SKILL_RULES}`;
  return {
    ...input,
    version: 1,
    instructions,
    estimatedTokens: Math.ceil(instructions.length / 3.7),
  };
}

export const BUILTIN_AGENT_SKILLS: readonly SkillDefinitionV1[] = Object.freeze([
  defineSkill({
    id: 'canvas-orchestration',
    summary: '创建、修改、连接、布局和定位画布节点',
    activation: ['画布', '节点', '连线', '布局', '选择', '标签', '标签组', 'canvas', 'node', 'connect', 'layout', 'rename', 'delete', 'move', 'tag'],
    toolNamespaces: ['canvas.read', 'canvas.write', 'canvas.navigate'],
    instructions: '先读取最小必要范围并复述目标对象；涉及多步修改时输出可编辑计划，再用共享画布命令完成并返回定位引用。标签与标签组必须使用 node.create、node.rename、node.setEnabled、node.duplicate、tag.setColor、tagGroup.setMembers、edge.connect、edge.disconnect 和 viewport.focus，不得直接写 Store。',
    examples: [{ input: '把这三个节点横向排好并连起来', outcome: '读取节点 -> 计划布局/连线 -> 审批 -> 一次事务执行 -> 定位结果' }],
    evalCaseIds: ['canvas-orchestration:graph-edit'],
  }),
  defineSkill({
    id: 'storyboard-planning',
    summary: '把故事拆成连续、可执行的分镜计划',
    activation: ['规划分镜', '分镜', '镜头', '景别', '故事板', 'storyboard', 'shot list', 'shot', 'scene beat'],
    toolNamespaces: ['canvas.read', 'canvas.write', 'prompting'],
    instructions: '先提取叙事节拍、角色连续性和时空关系；输出镜号、景别、机位、动作、时长和衔接。现有分镜节点用 storyboard.update 修改帧注释、顺序和导出样式；图片切分用 node.tool.run 的 split-storyboard 工作流，结果必须返回可定位 nodeId。',
    examples: [{ input: '把这段追逐戏拆成 6 个镜头', outcome: '生成 6 个连续镜头的结构化计划，确认后创建节点' }],
    evalCaseIds: ['storyboard-planning:six-shots'],
  }),
  defineSkill({
    id: 'image-prompt-director',
    summary: '编写可提交的生图与图片编辑提示词',
    activation: ['生图', '图片', '画面', '参考图', 'image prompt', 'generate image', 'edit image', 'reference image'],
    toolNamespaces: ['canvas.read', 'generation', 'prompting'],
    instructions: '区分从零生成与图片编辑；固定主体身份、构图、镜头、光线、风格和禁止项，提交前明确模型、数量、比例及参考图用途。从零生图必须调用 canvas_command 的 node.create，nodeType 只能写精确注册值 imageNode，configuration 写入 prompt、当前所选 modelId、aspectRatio、resolution；position 只是布局提示，不要自造 nodeId。只有创建结果 ok=true 后才可使用 output.references.nodeId 调用 generation.submit；generation.submit 的 input 只有非空 nodeIds，不接收 prompt。确定性的裁剪、标注和分镜切分使用 node.tool.run；高清、扩图、重绘、擦除和抠图依赖付费 AI 提交，当前不可通过 node.tool.run 调用，不要模拟 UI 点击或绕过持久任务边界。',
    examples: [{ input: '用角色参考图生成雨夜中景', outcome: '读取获批参考图 -> 生成身份一致提示词 -> 确认参数 -> 提交' }],
    evalCaseIds: ['image-prompt-director:identity-reference'],
  }),
  defineSkill({
    id: 'video-prompt-director',
    summary: '编写带时间、动作和运镜约束的视频提示词',
    activation: ['录制视频', '生视频', '视频', '运镜', '时间轴', '即梦', 'Seedance', 'video prompt', 'camera move', 'motion'],
    toolNamespaces: ['canvas.read', 'generation', 'prompting'],
    instructions: '用时间段描述主体动作、镜头运动、节奏和连续性；避免互相冲突的动作，提交前明确首尾帧、时长、比例、分辨率和模型。',
    examples: [{ input: '做一个 8 秒推镜，角色回头后奔跑', outcome: '形成分时视频提示词和完整提交参数，确认后执行' }],
    evalCaseIds: ['video-prompt-director:timed-motion'],
  }),
  defineSkill({
    id: 'director-studio',
    summary: '操作导演台角色、动作、镜头、时间轴和录制',
    activation: ['导演台', '角色动作', '录制', '蓝图', '3D', 'director studio', 'pose', 'timeline', 'record'],
    toolNamespaces: ['canvas.read', 'canvas.write', 'director', 'canvas.navigate'],
    instructions: '先确认导演台节点与当前项目；用 director.update 结构化修改场景、人物/物体、变换、动作、摄影机、灯光、画幅和时间轴，媒体只能引用 asset.list 返回的 assetId。用 director.open 打开并定位实时 3D 结果；录制前检查至少两个镜头关键帧、时长、FPS、分辨率及格式能力，再用 director.record 进入现有 clean MediaRecorder 路径并定位结果视频。全景节点用 panorama.update 配置后再 generation.submit。',
    examples: [{ input: '让人物挥手并录一段镜头', outcome: '定位导演台 -> 设计动作/镜头关键帧 -> 审批修改 -> 录制前确认' }],
    evalCaseIds: ['director-studio:motion-recording'],
  }),
  defineSkill({
    id: 'bulk-workflow',
    summary: '校验并批量导入提示词或创建节点',
    activation: ['批量', '表格', '导入', 'Excel', 'CSV', 'TSV', 'batch', 'spreadsheet', 'import table'],
    toolNamespaces: ['canvas.read', 'canvas.write', 'prompting'],
    instructions: '先识别表头、行数、空值和目标列，展示可排除的导入预览；确认后作为一个可撤销批次创建并布局节点。',
    examples: [{ input: '把这个 CSV 的 prompt 列导入画布', outcome: '解析预览 -> 报告无效行 -> 确认 -> 一次批量创建' }],
    evalCaseIds: ['bulk-workflow:table-import'],
  }),
  defineSkill({
    id: 'generation-diagnostics',
    summary: '诊断尺寸、能力、供应商、网络和任务失败',
    activation: ['诊断', '报错', '失败', '问题', 'Issue', '429', '500', '超时', '尺寸', 'diagnose', 'error', 'failed', 'timeout'],
    toolNamespaces: ['diagnostics'],
    instructions: '先用 application-logs 和 generation-jobs 读取同一份有界脱敏证据，再区分输入、配置、上游生成失败、结果取回失败、网络、应用缺陷或未知。查询画布时 canvas.query 必须使用 input.scope（graph、nodes、edges、selection 之一），可选 nodeIds 和 limit；不存在 filter 字段。工具参数校验失败时按返回的精确契约最多纠正一次，不得用同一组无效参数反复调用。只有 generation-jobs 返回明确 jobId、safeRecoveryAvailable=true 且有安全句柄时，才能提议 generation.recover；该命令仍需单独审批，只轮询/GET/本地保存，绝不能从日志文字解析 URL、索要密钥或重提付费 POST。恢复完成前不得声称成功。',
    examples: [{ input: '4K 3:4 为什么超出 8294400 像素', outcome: '计算几何约束，区分临时规避、配置映射和通用软件修复' }],
    evalCaseIds: ['generation-diagnostics:issue-11', 'generation-diagnostics:unknown-timeout', 'generation-diagnostics:fetch-only-recovery'],
  }),
  defineSkill({
    id: 'provider-configuration',
    summary: '检查并提出可回滚的供应商配置修复',
    activation: ['供应商', '配置', '模型', '接口', 'endpoint', 'base url', 'provider', 'API', 'capability'],
    toolNamespaces: ['diagnostics', 'config'],
    instructions: '只能查看脱敏配置状态和白名单字段；先生成字段级 dry-run diff，验证通过后另行审批应用，并保留回滚令牌。',
    examples: [{ input: '这个模型支持视觉但配置里没开', outcome: '读取脱敏能力 -> 预览 supportsMultimodal diff -> 单独审批应用' }],
    evalCaseIds: ['provider-configuration:capability-patch'],
  }),
  defineSkill({
    id: 'project-portability',
    summary: '检查项目和设置导入导出的兼容性',
    activation: ['项目迁移', '导入设置', '导出设置', '兼容', '备份', 'project migration', 'portability', 'backup', 'restore'],
    toolNamespaces: ['canvas.read', 'diagnostics', 'config'],
    instructions: '先检查 manifest/schema/app 版本和冲突摘要；保留未知兼容字段，凭据默认不导出，任何覆盖都必须先展示影响。',
    examples: [{ input: '检查这个旧项目能否迁移', outcome: '版本/结构预检 -> 冲突和保留字段摘要 -> 等待导入确认' }],
    evalCaseIds: ['project-portability:legacy-project'],
  }),
]);

export interface SkillRoutingContext {
  text: string;
  /**
   * Bounded recent user turns used only when `text` is clearly a continuation
   * (for example "继续" or "16:9，2K"). Assistant prose is deliberately not
   * included so tool examples in model replies cannot grant capabilities.
   */
  recentUserText?: string;
  attachmentKinds?: string[];
  selectedNodeTypes?: string[];
  errorCode?: string;
}

export interface SkillSelection {
  skill: SkillDefinitionV1;
  score: number;
  reason: string;
}

export function validateSkillDefinition(value: SkillDefinitionV1): string[] {
  const issues: string[] = [];
  if (value.version !== 1 || !/^[a-z0-9-]+$/.test(value.id)) issues.push('invalid id/version');
  if (!value.summary.trim() || !value.instructions.trim()) issues.push('summary/instructions required');
  if (!value.activation.length || value.activation.some((term) => !term.trim())) issues.push('activation terms required');
  if (!value.examples.length || value.examples.some((example) => !example.input.trim() || !example.outcome.trim())) issues.push('valid example required');
  if (!value.evalCaseIds.length || value.evalCaseIds.some((id) => !id.startsWith(`${value.id}:`))) issues.push('valid eval ids required');
  if (value.instructions.length > 18_000 || value.estimatedTokens > 5_000) issues.push('skill exceeds size budget');
  if (value.toolNamespaces.some((namespace) => !SAFE_NAMESPACES.has(namespace))) issues.push('unknown or unsafe tool namespace');
  if (/\b(?:use|execute|access|invoke|grant)\s+(?:a\s+)?(?:shell|filesystem|child_process)\b|eval\s*\(/i.test(value.instructions)) issues.push('skill contains forbidden capability or secret access');
  return issues;
}

export function validateSkillCatalog(values: readonly SkillDefinitionV1[]): string[] {
  const issues = values.flatMap((value) => validateSkillDefinition(value).map((issue) => `${value.id}: ${issue}`));
  const ids = new Set<string>();
  const evalIds = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) issues.push(`${value.id}: duplicate skill id`);
    ids.add(value.id);
    for (const evalId of value.evalCaseIds) {
      if (evalIds.has(evalId)) issues.push(`${value.id}: duplicate eval id ${evalId}`);
      evalIds.add(evalId);
    }
  }
  return issues;
}

function attachmentBoost(skill: SkillDefinitionV1, context: SkillRoutingContext): number {
  const attachments = context.attachmentKinds ?? [];
  if (!attachments.includes('image')) return 0;
  return ['image-prompt-director', 'storyboard-planning', 'generation-diagnostics'].includes(skill.id) ? 1 : 0;
}

function selectedNodeBoost(skill: SkillDefinitionV1, context: SkillRoutingContext): number {
  const nodeTypes = (context.selectedNodeTypes ?? []).map((value) => value.toLowerCase());
  if (nodeTypes.some((value) => /blueprint|director/.test(value)) && skill.id === 'director-studio') return 2;
  if (nodeTypes.some((value) => /video/.test(value)) && skill.id === 'video-prompt-director') return 1;
  return 0;
}

export function routeAgentSkills(context: SkillRoutingContext, max = 3): SkillSelection[] {
  const currentText = `${context.text} ${context.errorCode ?? ''}`.toLocaleLowerCase();
  const continuation = isLikelyTaskContinuation(context.text);
  const recentText = continuation ? context.recentUserText?.trim().toLocaleLowerCase() ?? '' : '';
  const text = recentText ? `${recentText}\n${currentText}` : currentText;
  const scored = BUILTIN_AGENT_SKILLS.map((skill) => {
    const currentTermHits = skill.activation.filter((term) => currentText.includes(term.toLocaleLowerCase())).length;
    const termHits = skill.activation.filter((term) => text.includes(term.toLocaleLowerCase())).length;
    const errorBoost = context.errorCode && skill.id === 'generation-diagnostics' ? 4 : 0;
    const mediaBoost = attachmentBoost(skill, context);
    const nodeBoost = selectedNodeBoost(skill, context);
    const score = termHits + errorBoost + mediaBoost + nodeBoost;
    const signals = [
      currentTermHits ? `${currentTermHits} 个领域词` : '',
      !currentTermHits && termHits && recentText ? `延续最近任务的 ${termHits} 个领域词` : '',
      errorBoost ? '错误码' : '',
      mediaBoost ? '图片附件' : '',
      nodeBoost ? '选中节点类型' : '',
    ].filter(Boolean);
    return {
      skill,
      score,
      reason: signals.length ? `匹配${signals.join('、')}。` : '未命中领域信号。',
    };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
    .slice(0, Math.min(3, Math.max(1, max)));
}

function isLikelyTaskContinuation(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 160) return false;
  if (/^(?:继续|默认|确认|执行|开始|可以|好的?|行|就这样|按这个|同意|批准|yes|ok|okay|continue|go ahead)[！!。.\s]*$/i.test(text)) {
    return true;
  }
  return /(?:\b(?:1k|2k|4k|8k|fps)\b|\d+\s*(?::|比)\s*\d+|\d+\s*秒|上一步|刚才|上述|按前面|用这个|就这个|(?:看看|检查|查询).{0,8}(?:状态|进度|结果)|(?:现在)?(?:状态|进度|结果).{0,8}(?:怎么样|如何|呢|了|[？?])|(?:生成|任务|图片|视频|结果).{0,10}(?:完成|生成好|好了|成功|状态|进度|出来).{0,4}(?:吗|没有|没|了|[？?])?)/i.test(text);
}

export function buildSkillContext(context: SkillRoutingContext): {
  index: string;
  selections: SkillSelection[];
  instructions: string;
  toolNamespaces: string[];
  estimatedTokens: number;
} {
  const selections = routeAgentSkills(context);
  const index = BUILTIN_AGENT_SKILLS.map((skill) => `${skill.id}: ${skill.summary}`).join('\n');
  const instructions = selections.length
    ? selections.map((selection) => selection.skill.instructions).join('\n\n')
    : '本轮没有命中专用技能。只使用最小画布能力确认对象和意图；若目标仍不明确，先向用户提出一个具体澄清问题。';
  const toolNamespaces = Array.from(new Set(selections.flatMap((selection) => selection.skill.toolNamespaces)));
  return {
    index,
    selections,
    instructions,
    toolNamespaces,
    estimatedTokens: selections.reduce((sum, selection) => sum + selection.skill.estimatedTokens, 0),
  };
}

export function resolveAgentToolPolicy(input: {
  skillContext: ReturnType<typeof buildSkillContext>;
  supportsVision: boolean;
  supportsToolSearch: boolean;
  protocol?: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages' | 'google-gemini';
}): AgentToolPolicy {
  const namespaces = new Set(input.skillContext.toolNamespaces);
  if (input.skillContext.selections.length === 0) {
    return {
      mode: 'minimal',
      toolKinds: [],
      deferredToolKinds: [],
      reason: '未命中画布任务信号，本轮作为普通对话或澄清轮次，不发送大型画布工具协议。',
    };
  }

  const needsCanvas = Array.from(namespaces).some((namespace) => (
    namespace.startsWith('canvas.')
    || namespace === 'generation'
    || namespace === 'director'
  ));
  const needsAssetRead = input.supportsVision && Array.from(namespaces).some((namespace) => (
    namespace === 'canvas.read'
    || namespace === 'generation'
    || namespace === 'prompting'
    || namespace === 'director'
  ));
  const toolKinds: AgentToolKind[] = [
    ...(needsCanvas ? ['canvas' as const] : []),
    ...(needsAssetRead ? ['asset-read' as const] : []),
    ...(namespaces.has('diagnostics') ? ['diagnostics' as const] : []),
    ...(namespaces.has('config') ? ['config' as const] : []),
  ];
  const uniqueToolKinds = Array.from(new Set(toolKinds));
  const supportsNativeToolSearch = input.supportsToolSearch
    && input.protocol === 'openai-responses';
  return {
    mode: supportsNativeToolSearch ? 'tool-search' : 'local-router',
    toolKinds: uniqueToolKinds,
    deferredToolKinds: supportsNativeToolSearch ? uniqueToolKinds.filter((kind) => kind !== 'canvas') : [],
    reason: `根据 ${input.skillContext.selections.map((selection) => selection.skill.id).join('、')} 裁剪为 ${uniqueToolKinds.length} 个工具入口。`,
  };
}
