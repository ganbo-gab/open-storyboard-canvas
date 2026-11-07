import type {
  AsyncResponse, ChannelProfileV2, JsonValue, ModeSpec, ModelSpec, OperationSpec, ParamSpec, RefSlot,
} from '../domain/profile';

// Official contracts and retrieval dates: docs/rework/09-视频模型预设核实.md.
function choice(key: string, label: string, values: JsonValue[], defaultValue: JsonValue,
  description: string, group: 'basic' | 'advanced' = 'basic'): ParamSpec {
  return { key, label, type: 'enum', options: values.map((value) => ({
    label: value === -1 ? '智能选择' : String(value), value,
  })), default: defaultValue, description, group };
}
function flag(key: string, label: string, defaultValue: boolean, description: string,
  group: 'basic' | 'advanced' = 'advanced'): ParamSpec {
  return { key, label, type: 'boolean', default: defaultValue, description, group };
}
const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const seconds = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, index) => min + index);
const frameSlots: RefSlot[] = [
  { key: 'first_frame', label: '首帧图片', kind: 'image', min: 1, max: 1 },
  { key: 'last_frame', label: '尾帧图片', kind: 'image', min: 1, max: 1 },
];
function referenceSlots(images: number, videos: number, audios: number, required: 'image' | 'video' | 'audio'): RefSlot[] {
  return [
    { key: 'reference_image', label: '参考图片', kind: 'image', min: required === 'image' ? 1 : 0, max: images },
    { key: 'reference_video', label: '参考视频', kind: 'video', min: required === 'video' ? 1 : 0, max: videos },
    { key: 'reference_audio', label: '参考音频', kind: 'audio', min: required === 'audio' ? 1 : 0, max: audios },
  ];
}
const seedanceResponse: AsyncResponse = {
  mode: 'async', taskIdPath: 'id', poll: {
    method: 'GET', path: '/api/v3/contents/generations/tasks/{{taskId}}', intervalSec: 10, timeoutMin: 30,
    statusPath: 'status', success: ['succeeded'], failure: ['failed', 'cancelled', 'expired'],
    outputs: [{ path: 'content.video_url', as: 'url', kind: 'video' },
      { path: 'content.last_frame_url', as: 'url', kind: 'image' }],
  },
};
function seedanceEndpoint(is25: boolean, taskType?: 'reference' | 'edit' | 'extend'): OperationSpec {
  return {
    method: 'POST', path: '/api/v3/contents/generations/tasks', body: 'json', imageEncoding: 'url',
    template: {
      model: '{{model}}', content: '{{seedanceContent}}', resolution: '{{param.resolution}}',
      ratio: '{{param.ratio}}', duration: '{{param.duration}}', generate_audio: '{{param.generate_audio}}',
      watermark: '{{param.watermark}}', return_last_frame: '{{param.return_last_frame}}',
      priority: '{{param.priority}}', execution_expires_after: '{{param.execution_expires_after}}',
      ...(is25 ? { output_format: '{{param.output_format}}' } : {}),
      ...(taskType ? { omni_reference_task_type: taskType } : {}),
    },
    response: seedanceResponse, errorPath: 'error.message',
  };
}
function seedanceModel(prefix: 'doubao' | 'dreamina', version: '2.5' | '2.0' | '2.0-fast' | '2.0-mini'): ModelSpec {
  const is25 = version === '2.5';
  const imageMax = is25 ? 30 : 9;
  const avMax = is25 ? 10 : 3;
  const ratio = choice('ratio', '画面比例', ['adaptive', ...ratios], 'adaptive', '自动适配或使用指定比例。');
  const adaptive = choice('ratio', '画面比例', ['adaptive'], 'adaptive', '此模式必须保留输入素材比例。');
  const modes: ModeSpec[] = [
    { id: 'text-to-video', label: '文生视频', operation: 'video.generate', slots: [],
      params: [ratio], endpoint: seedanceEndpoint(is25) },
    { id: 'first-frame', label: '首帧生视频', operation: 'video.generate', slots: [frameSlots[0]],
      params: [is25 ? adaptive : ratio], endpoint: seedanceEndpoint(is25) },
    { id: 'first-last-frame', label: '首尾帧生视频', operation: 'video.generate', slots: frameSlots,
      params: [is25 ? adaptive : ratio], endpoint: seedanceEndpoint(is25) },
    { id: 'reference-images', label: '全能参考 · 图片起步', operation: 'video.generate',
      description: '至少一张参考图，可同时加入视频和音频；不能混入严格首尾帧。',
      slots: referenceSlots(imageMax, avMax, avMax, 'image'), params: [ratio],
      endpoint: seedanceEndpoint(is25, is25 ? 'reference' : undefined) },
    { id: 'reference-video', label: '全能参考 · 视频起步', operation: 'video.generate',
      description: is25 ? '至少一个参考视频，可同时加入图片和音频。' : '至少一个参考视频；生成、编辑或延长意图通过提示词表达。',
      slots: referenceSlots(imageMax, avMax, avMax, 'video'), params: [ratio],
      endpoint: seedanceEndpoint(is25, is25 ? 'reference' : undefined) },
  ];
  if (is25) modes.push(
    { id: 'reference-audio', label: '全能参考 · 音频起步', operation: 'video.generate',
      description: '支持纯音频参考，也可加入参考图和参考视频。',
      slots: referenceSlots(imageMax, avMax, avMax, 'audio'), params: [ratio], endpoint: seedanceEndpoint(true, 'reference') },
    { id: 'video-edit', label: '视频编辑', operation: 'video.generate',
      description: '提示词必须表达编辑意图；待编辑视频为 4–30 秒，输出时长跟随原视频。',
      slots: referenceSlots(imageMax, avMax, avMax, 'video'), params: [adaptive,
        choice('duration', '输出时长', [-1], -1, '视频编辑必须为 -1，保留原视频时长。')],
      endpoint: seedanceEndpoint(true, 'edit') },
    { id: 'video-extend', label: '视频延长', operation: 'video.generate',
      description: '提示词明确向前或向后延长哪个参考视频；比例跟随原视频。',
      slots: referenceSlots(imageMax, avMax, avMax, 'video'), params: [adaptive], endpoint: seedanceEndpoint(true, 'extend') },
  );
  const suffix = version === '2.5' ? '2-5-260628' : version === '2.0' ? '2-0-260128'
    : version === '2.0-fast' ? '2-0-fast-260128' : '2-0-mini-260615';
  return {
    id: `${prefix}-seedance-${suffix}`, label: `Seedance ${version}`, operations: ['video.generate'], mention: 'en-at',
    params: [
      choice('resolution', '分辨率', is25 ? ['480p', '720p', '1080p']
        : version === '2.0' ? ['480p', '720p', '1080p', '4k'] : ['480p', '720p'], '720p', '大小写按官方枚举原样发送。'),
      choice('duration', '时长（秒）', [-1, ...seconds(4, is25 ? 30 : 15)], is25 ? -1 : 5,
        '智能选择会影响最终时长和费用；固定时长按整数秒选择。'),
      flag('generate_audio', '生成同步声音', true, '生成对白、音效和背景音乐；关闭则输出无声视频。', 'basic'),
      flag('watermark', '添加水印', false, '在输出视频上添加 AI 生成水印。'),
      flag('return_last_frame', '返回尾帧图片', false, '同时保存生成视频的 JPEG 尾帧，可用于下一镜头。'),
      { key: 'priority', label: '队列优先级', type: 'number', min: 0, max: 9, step: 1, group: 'advanced',
        description: '仅影响同一推理接入点的排队顺序，不中断执行中的任务。' },
      { key: 'execution_expires_after', label: '上游任务过期秒数', type: 'number', min: 3600, max: 259200, step: 1,
        group: 'advanced', description: '从任务创建时计时；不填写时采用上游默认值 172800 秒。' },
      ...(is25 ? [choice('output_format', '输出格式', ['mp4', 'mov'], 'mp4', 'MOV 面向专业后期，部分播放器不兼容。', 'advanced')] : []),
    ], modes,
  };
}
const seedanceNotes = [
  '首帧、首尾帧与全能参考互斥；2.0 的音频参考必须同时有图片或视频，2.5 支持纯音频参考。',
  '单图小于 30MB、300–6000px、宽高比 0.4–2.5；视频 MP4/MOV ≤200MB，24–60fps。请求体 ≤64MB。',
  '2.0 视频/音频每段 2–15 秒、各类总时长 ≤15 秒；2.5 每段 2–30 秒、各类总时长 ≤30 秒（编辑视频至少 4 秒）；音频 WAV/MP3 ≤15MB。',
  '2.5 的 1080p 和 2.0 的 4k 使用 10bit HEVC，可能需要兼容播放器。人脸素材须满足平台授权规则。',
  '未暴露仅旧模型支持的 seed、camera_fixed、frames；Draft 两阶段样片转成片、素材库授权与回调不由本预设自动执行。',
  '预设使用公网素材 URL；本地素材需先通过现有素材解析流程取得可访问 URL。结果链接 24 小时有效，任务记录保留 7 天。',
];
export const volcengineSeedanceProfile: ChannelProfileV2 = {
  version: 2, id: 'volcengine-seedance', name: '火山方舟 · Seedance', baseUrl: 'https://ark.cn-beijing.volces.com',
  auth: { type: 'bearer' }, docsUrl: 'https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh',
  notes: seedanceNotes, operations: { 'video.generate': seedanceEndpoint(false) },
  models: (['2.5', '2.0', '2.0-fast', '2.0-mini'] as const).map((version) => seedanceModel('doubao', version)),
};
export const bytePlusSeedanceProfile: ChannelProfileV2 = {
  version: 2, id: 'byteplus-seedance', name: 'BytePlus ModelArk · Seedance', baseUrl: 'https://ark.ap-southeast.bytepluses.com',
  auth: { type: 'bearer' }, docsUrl: 'https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api',
  notes: seedanceNotes, operations: { 'video.generate': seedanceEndpoint(false) },
  models: (['2.5', '2.0', '2.0-fast', '2.0-mini'] as const).map((version) => seedanceModel('dreamina', version)),
};

const minimaxResponse: AsyncResponse = {
  mode: 'async', taskIdPath: 'task_id', poll: {
    method: 'GET', path: '/v2/query/video_generation/{{taskId}}', intervalSec: 10, timeoutMin: 30,
    statusPath: 'task.status', success: ['succeeded'], failure: ['failed', 'cancelled'],
    outputs: [{ path: 'task.content.url', as: 'url', kind: 'video' }],
  },
};
function h3Endpoint(max: boolean, china: boolean): OperationSpec {
  return {
    method: 'POST', path: '/v2/video_generation', body: 'json', imageEncoding: 'url',
    template: { model: '{{model}}', content: '{{seedanceContent}}', resolution: '{{param.resolution}}',
      duration: '{{param.duration}}', ratio: '{{param.ratio}}',
      ...(max ? { extra: { prompt_expansion_mode: '{{param.prompt_expansion_mode}}' } } : {}),
      ...(china ? { aigc_watermark: '{{param.aigc_watermark}}' } : {}) },
    response: minimaxResponse, errorPath: 'task.error.message',
  };
}
function h3Model(max: boolean, china: boolean): ModelSpec {
  const endpoint = h3Endpoint(max, china);
  const ratio = choice('ratio', '画面比例', ['adaptive', ...ratios], 'adaptive', '参考模式支持自适应或指定比例。');
  const adaptive = choice('ratio', '画面比例', ['adaptive'], 'adaptive', '严格首尾帧模式跟随输入图片比例。');
  return {
    id: max ? 'MiniMax-H3-Max' : 'MiniMax-H3', label: max ? 'MiniMax H3 Max（极速）' : 'MiniMax H3',
    operations: ['video.generate'], mention: 'natural', params: [
      choice('resolution', '分辨率', max ? ['480P', '768P'] : ['768P', '2K'], '768P', 'H3 Max 不支持 2K。'),
      choice('duration', '时长（秒）', seconds(max ? 5 : 4, 15), 5, '整数秒；H3 为 4–15 秒，H3 Max 为 5–15 秒。'),
      ...(max ? [choice('prompt_expansion_mode', '提示词扩写', ['disabled', 'balanced', 'quality'], 'balanced',
        '仅 H3 Max：关闭、平衡或质量优先；不是布尔开关。', 'advanced')] : []),
      ...(china ? [flag('aigc_watermark', '添加水印', false, '仅国内平台文档声明的 AIGC 水印字段。')] : []),
    ], modes: [
      { id: 'text-to-video', label: '文生视频', operation: 'video.generate', slots: [], endpoint,
        params: [choice('ratio', '画面比例', ratios, '16:9', '纯文本模式必须指定具体比例，不允许 adaptive。')] },
      { id: 'first-frame', label: '首帧生视频', operation: 'video.generate', slots: [frameSlots[0]], params: [adaptive], endpoint },
      { id: 'first-last-frame', label: '首尾帧生视频', operation: 'video.generate', slots: frameSlots, params: [adaptive], endpoint },
      { id: 'reference-images', label: '多模态参考 · 图片起步', operation: 'video.generate',
        slots: referenceSlots(9, 3, 3, 'image'), params: [ratio], endpoint },
      { id: 'reference-video', label: '多模态参考 · 视频起步', operation: 'video.generate',
        slots: referenceSlots(9, 3, 3, 'video'), params: [ratio], endpoint },
      { id: 'reference-audio', label: '多模态参考 · 音频起步', operation: 'video.generate',
        slots: referenceSlots(9, 3, 3, 'audio'), params: [ratio], endpoint },
    ],
  };
}
const hailuoResponse: AsyncResponse = {
  mode: 'async', taskIdPath: 'task_id', poll: {
    method: 'GET', path: '/v1/query/video_generation?task_id={{taskId}}', intervalSec: 10, timeoutMin: 30,
    statusPath: 'status', success: ['Success'], failure: ['Fail'],
    resultRequest: { method: 'GET', path: '/v1/files/retrieve?file_id={{poll.file_id}}' },
    outputs: [{ path: 'file.download_url', as: 'url', kind: 'video' }],
  },
};
function hailuoEndpoint(mode: 'text' | 'first' | 'first-last'): OperationSpec {
  return {
    method: 'POST', path: '/v1/video_generation', body: 'json', imageEncoding: 'url',
    template: { model: '{{model}}', prompt: '{{prompt}}', duration: '{{param.output.duration}}',
      resolution: '{{param.output.resolution}}', prompt_optimizer: '{{param.prompt_optimizer}}',
      ...(mode !== 'first-last' ? { fast_pretreatment: '{{param.fast_pretreatment}}' } : {}),
      ...(mode !== 'text' ? { first_frame_image: '{{slotFirst.first_frame}}' } : {}),
      ...(mode === 'first-last' ? { last_frame_image: '{{slotFirst.last_frame}}' } : {}) },
    response: hailuoResponse, errorPath: 'base_resp.status_msg',
  };
}
function hailuoOutput(allow512: boolean): ParamSpec {
  const combinations = [
    ...(allow512 ? [{ duration: 6, resolution: '512P' }, { duration: 10, resolution: '512P' }] : []),
    { duration: 6, resolution: '768P' }, { duration: 6, resolution: '1080P' }, { duration: 10, resolution: '768P' },
  ];
  return { key: 'output', label: '时长与分辨率', type: 'enum', group: 'basic', default: { duration: 6, resolution: '768P' },
    description: '只提供官方允许的组合；1080P 不支持 10 秒。',
    options: combinations.map((value) => ({ label: `${value.duration} 秒 · ${value.resolution}`, value })) };
}
function hailuoModel(id: 'MiniMax-Hailuo-2.3' | 'MiniMax-Hailuo-2.3-Fast' | 'MiniMax-Hailuo-02'): ModelSpec {
  const fast = flag('fast_pretreatment', '快速预处理', false, '仅在提示词优化开启时减少优化耗时。');
  return { id, label: id, operations: ['video.generate'], params: [
    flag('prompt_optimizer', '提示词优化', true, '由上游优化提示词。'),
  ], modes: [
    ...(id.endsWith('-Fast') ? [] : [{ id: 'text-to-video', label: '文生视频', operation: 'video.generate' as const,
      slots: [], params: [hailuoOutput(false), fast], endpoint: hailuoEndpoint('text') }]),
    { id: 'first-frame', label: '首帧生视频', operation: 'video.generate', slots: [frameSlots[0]],
      params: [hailuoOutput(id === 'MiniMax-Hailuo-02'), fast], endpoint: hailuoEndpoint('first') },
    ...(id === 'MiniMax-Hailuo-02' ? [{ id: 'first-last-frame', label: '首尾帧生视频', operation: 'video.generate' as const,
      slots: frameSlots, params: [hailuoOutput(false)], endpoint: hailuoEndpoint('first-last') }] : []),
  ] };
}
const minimaxNotes = [
  'H3 的官方模型 ID 为 MiniMax-H3 / MiniMax-H3-Max；Hailuo-03 是协议描述，不是模型 ID。',
  'H3 每次必须有非空提示词（≤7000 字符）；参考图/视频/音频与严格首尾帧互斥。混合素材总数 ≤12。',
  'H3 图片 ≤30MB、256–5760px、宽高比 0.4–2.5；参考视频 ≤50MB、2–15秒、总时长≤15秒、23.976–60fps；参考音频 WAV/MP3 ≤15MB、2–15秒、总时长≤15秒。请求体 ≤64MB。',
  'H3-Max 多模态参考以详细 API 契约为准，模型概览描述有冲突；H3 单尾帧文档自相矛盾，不预设该模式。',
  'Hailuo2.3 Fast 仅首帧；02 才提供旧版首尾帧。旧模型提示词 ≤2000 字符，图片 <20MB、短边 >300px、宽高比 0.4–2.5。',
  'Hailuo V1 成功后用 poll.file_id 查询文件下载地址，不把 task_id 当成 file_id；下载链接 1 小时有效。H3 V2 查询直接返回 task.content.url。',
  '公网素材 URL 由现有引用解析流程提供；本预设不自动上传素材、建立人物库或配置回调。H3 查询记录保留 7 天。',
];
export const miniMaxVideoProfile: ChannelProfileV2 = {
  version: 2, id: 'minimax-video', name: 'MiniMax 国际 · H3 / 海螺', baseUrl: 'https://api.minimax.io',
  auth: { type: 'bearer' }, docsUrl: 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create',
  notes: minimaxNotes, operations: { 'video.generate': h3Endpoint(false, false) },
  models: [h3Model(false, false), h3Model(true, false), hailuoModel('MiniMax-Hailuo-2.3'),
    hailuoModel('MiniMax-Hailuo-2.3-Fast'), hailuoModel('MiniMax-Hailuo-02')],
};
export const miniMaxChinaVideoProfile: ChannelProfileV2 = {
  version: 2, id: 'minimax-china-video', name: 'MiniMax 国内 · H3 / 海螺', baseUrl: 'https://api.minimax.cn',
  auth: { type: 'bearer' }, docsUrl: 'https://platform.minimax.cn/docs/api-reference/video-generation-v2-create',
  notes: minimaxNotes, operations: { 'video.generate': h3Endpoint(false, true) },
  models: [h3Model(false, true), h3Model(true, true), hailuoModel('MiniMax-Hailuo-2.3'),
    hailuoModel('MiniMax-Hailuo-2.3-Fast'), hailuoModel('MiniMax-Hailuo-02')],
};

const wanResponse: AsyncResponse = {
  mode: 'async', taskIdPath: 'output.task_id', poll: {
    method: 'GET', path: '/api/v1/tasks/{{taskId}}', intervalSec: 15, timeoutMin: 30,
    statusPath: 'output.task_status', success: ['SUCCEEDED'], failure: ['FAILED', 'CANCELED', 'UNKNOWN'],
    outputs: [{ path: 'output.video_url', as: 'url', kind: 'video' }],
  },
};
const wanEndpoint: OperationSpec = {
  method: 'POST', path: '/api/v1/services/aigc/video-generation/video-synthesis', body: 'json', imageEncoding: 'url',
  template: { model: '{{model}}', input: { prompt: '{{prompt}}', media: '{{wanMedia}}' }, parameters: {
    resolution: '{{param.resolution}}', ratio: '{{param.ratio}}', duration: '{{param.duration}}',
    audio: '{{param.audio}}', prompt_extend: '{{param.prompt_extend}}', watermark: '{{param.watermark}}', seed: '{{param.seed}}',
  } }, response: wanResponse, errorPath: 'output.message',
};
function wanModel(id: string): ModelSpec {
  const ratio = choice('ratio', '画面比例', ['adaptive', ...ratios], 'adaptive', '参考素材自动适配，或指定目标比例。');
  return { id, label: id === 'wan3.0-video-prime' ? '通义万相 3.0 Prime（高速）' : '通义万相 3.0',
    operations: ['video.generate'], mention: 'natural', params: [
      choice('resolution', '分辨率', ['480P', '720P', '1080P'], '1080P', '输出固定 30fps；无可调整的 fps 字段。'),
      ratio, choice('duration', '时长（秒）', [-1, ...seconds(2, 30)], 5,
        '有参考视频时，输入视频总时长加输出时长不能超过 30 秒；-1 由模型智能选择。'),
      flag('audio', '输出声音', true, '输出包含音轨；与参考音频输入不同。', 'basic'),
      flag('prompt_extend', '智能改写提示词', true, '改善短提示词的生成质量，但增加耗时。'),
      flag('watermark', '添加水印', false, '在输出视频添加水印。'),
      { key: 'seed', label: '随机种子', type: 'number', min: -1, max: 2147483647, step: 1, group: 'advanced',
        description: '-1 或不填写使用随机种子；相同种子不保证结果完全相同。' },
    ], modes: [
      { id: 'text-to-video', label: '文生视频', operation: 'video.generate', slots: [], endpoint: wanEndpoint },
      { id: 'first-frame', label: '首帧生视频', operation: 'video.generate', slots: [frameSlots[0]], endpoint: wanEndpoint },
      { id: 'first-last-frame', label: '首尾帧生视频', operation: 'video.generate', slots: frameSlots, endpoint: wanEndpoint },
      ...(['image', 'video', 'audio'] as const).map((kind): ModeSpec => ({
        id: `reference-${kind}`, label: `全能参考 · ${{ image: '图片', video: '视频', audio: '音频' }[kind]}起步`,
        operation: 'video.generate', slots: referenceSlots(10, 5, 5, kind), endpoint: wanEndpoint,
      })),
      { id: 'video-edit', label: '视频编辑', operation: 'video.generate',
        description: '通过提示词明确编辑 Video 1；推荐自适应比例与智能时长。',
        slots: referenceSlots(10, 5, 5, 'video'), endpoint: wanEndpoint, params: [
          choice('ratio', '画面比例', ['adaptive', ...ratios], 'adaptive', '官方推荐 adaptive 保留原视频比例。'),
          choice('duration', '时长（秒）', [-1, ...seconds(2, 30)], -1, '官方推荐 -1；输入视频总时长加输出时长 ≤30 秒。'),
        ] },
      { id: 'video-extend', label: '视频延长', operation: 'video.generate',
        description: '提示词明确将 Video 1 向前或向后延长；输入总时长加输出时长 ≤30 秒。',
        slots: referenceSlots(10, 5, 5, 'video'), endpoint: wanEndpoint },
    ] };
}
export const wanVideoProfile: ChannelProfileV2 = {
  version: 2, id: 'alibaba-wan-video', name: '阿里云百炼 · 万相 3.0（需填写工作空间地址）',
  baseUrl: 'https://your-workspace-id.cn-beijing.maas.aliyuncs.com', auth: { type: 'bearer' },
  headers: { 'X-DashScope-Async': 'enable' },
  docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference',
  notes: [
    '必须将 baseUrl 中 your-workspace-id 替换为控制台真实工作空间 ID，并确保模型、API Key、工作空间和地域一致。此示例地址不是已开通账号。',
    '官方地域域名：{WorkspaceId}.cn-beijing.maas.aliyuncs.com（北京）、.ap-southeast-1.maas.aliyuncs.com（新加坡）；还支持弗吉尼亚、东京、法兰克福和香港。',
    'Wan3.0 当前为 Preview。首帧/首尾帧不可混入任何参考素材；参考音频不等于输出声音开关。视频编辑和延长由提示词意图决定，无独立 task_type 字段。',
    '最多 10 图、5 视频、5 音频，共 ≤20 项；图 ≤20MB、240–8000px，视频 MP4/MOV ≤100MB、1–15 秒且总时长≤15秒、≥16fps、240–4096px；音频 WAV/MP3 ≤15MB、1–15秒且总时长≤15秒。素材宽高比 1:8–8:1。',
    '输入视频总时长加输出时长 ≤30 秒；提示词 ≤20000 字符。文件大小、编码和时长总和仍须符合上游限制。',
    '请求体不发送旧版 size、negative_prompt、shot_type 或 generate_audio。文件/网页参考不属于媒体素材槽位，本预设不自动解析文档或网页。',
    '预设使用公网素材 URL；任务 ID 和结果链接 24 小时有效，成功后立即保存本地资产。',
  ], operations: { 'video.generate': wanEndpoint }, models: [wanModel('wan3.0-video'), wanModel('wan3.0-video-prime')],
};

const viduResponse: AsyncResponse = {
  mode: 'async', taskIdPath: 'task_id', poll: {
    method: 'GET', path: '/ent/v2/tasks/{{taskId}}/creations', intervalSec: 10, timeoutMin: 30,
    statusPath: 'state', success: ['success'], failure: ['failed'],
    outputs: [{ path: 'creations[*].url', as: 'url', kind: 'video' }],
  },
};
function viduEndpoint(mode: 'text' | 'first' | 'first-last' | 'reference'): OperationSpec {
  return { method: 'POST', path: `/ent/v2/${{ text: 'text2video', first: 'img2video', 'first-last': 'start-end2video', reference: 'reference2video' }[mode]}`,
    body: 'json', imageEncoding: 'url', template: {
      model: '{{model}}', prompt: '{{prompt}}', duration: '{{param.duration}}', resolution: '{{param.resolution}}',
      audio: '{{param.audio}}', seed: '{{param.seed}}',
      ...(mode === 'text' || mode === 'reference' ? { aspect_ratio: '{{param.aspect_ratio}}' } : {}),
      ...(mode === 'first' ? { images: '{{slot.first_frame}}', is_rec: '{{param.is_rec}}' } : {}),
      ...(mode === 'first-last' ? { images: ['{{slotFirst.first_frame}}', '{{slotFirst.last_frame}}'] } : {}),
      ...(mode === 'reference' ? { images: '{{slot.reference_image}}' } : {}),
    }, response: viduResponse, errorPath: 'err_code' };
}
function viduModel(id: 'viduq3-pro' | 'viduq3-turbo' | 'viduq3-pro-fast' | 'viduq3'): ModelSpec {
  const aspect = choice('aspect_ratio', '画面比例', ['16:9', '9:16', '3:4', '4:3', '1:1'], '16:9', '文生与多图参考可指定画幅。');
  const modes: ModeSpec[] = [];
  if (id === 'viduq3-pro' || id === 'viduq3-turbo') modes.push({
    id: 'text-to-video', label: '文生视频', operation: 'video.generate', slots: [], params: [aspect], endpoint: viduEndpoint('text'),
  });
  if (id !== 'viduq3') modes.push({
    id: 'first-frame', label: '首帧生视频', operation: 'video.generate', slots: [frameSlots[0]],
    params: [flag('is_rec', '使用推荐提示词', false, '开启后由上游推荐提示词，可能忽略填写的提示词。')], endpoint: viduEndpoint('first'),
  }, { id: 'first-last-frame', label: '首尾帧生视频', operation: 'video.generate', slots: frameSlots,
    endpoint: viduEndpoint('first-last') });
  if (id === 'viduq3') modes.push({
    id: 'reference-images', label: '多图参考生视频', operation: 'video.generate',
    slots: [{ key: 'reference_image', label: '参考图片', kind: 'image', min: 1, max: 7 }], params: [aspect], endpoint: viduEndpoint('reference'),
  });
  return { id, label: id, operations: ['video.generate'], params: [
    choice('duration', '时长（秒）', seconds(id === 'viduq3' ? 3 : 1, 16), 5, '整数秒；各模式采用当前模型独立文档范围。'),
    choice('resolution', '分辨率', id === 'viduq3-pro-fast' ? ['720p', '1080p'] : ['540p', '720p', '1080p'], '720p', '图生模式保留输入画幅。'),
    flag('audio', '生成同步声音', true, '生成带对白与音效的视频；关闭输出无声视频。', 'basic'),
    { key: 'seed', label: '随机种子', type: 'number', step: 1, group: 'advanced', description: '不填写或设为 0 使用随机种子。' },
  ], modes };
}
export const viduVideoProfile: ChannelProfileV2 = {
  version: 2, id: 'vidu-video', name: 'Vidu 官方 · Q3', baseUrl: 'https://api.vidu.com',
  auth: { type: 'header', name: 'Authorization', prefix: 'Token ' },
  docsUrl: 'https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video',
  notes: [
    'Q3 Pro/Turbo 文生与图生 1–16 秒；Q3 多图参考 3–16 秒、1–7 张图。Q3 Pro Fast 仅图生，分辨率为 720p/1080p。',
    '首帧 1 图，首尾帧 2 图且像素面积比 0.8–1.25；PNG/JPEG/JPG/WEBP，宽高比 1:4–4:1，单图 ≤50MB、Base64 解码后 <10MB；多图参考请求体 ≤20MB、图片至少128×128。',
    'Q3 Turbo 的主体参考接口使用 subjects 结构，不等同于 Q3 普通 images 多图参考；本预设不自动创建主体库。',
    'Q4 Preview 官方参考页创建使用 Token、查询页却写 Bearer，存在鉴权冲突，未注册该未能一致核实的预设。',
    '未暴露文档样例中残留但当前参数表未声明的 movement_amplitude；未配置回调、错峰任务或自定义水印。结果链接 24 小时有效。',
  ], operations: { 'video.generate': viduEndpoint('text') },
  models: [viduModel('viduq3-pro'), viduModel('viduq3-turbo'), viduModel('viduq3-pro-fast'), viduModel('viduq3')],
};

export const officialVideoPresets: ChannelProfileV2[] = [
  volcengineSeedanceProfile, bytePlusSeedanceProfile, miniMaxVideoProfile, miniMaxChinaVideoProfile, wanVideoProfile, viduVideoProfile,
];
