import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * User-defined image-generation provider config. Intentionally flexible — most
 * real deployments are reverse proxies / aggregators with non-standard shapes,
 * so we store the raw fields and let the generation adapter reshape them.
 */
export type CustomProviderMediaType = 'image' | 'video' | 'chat';

export interface CustomProviderChatModelMetadata {
  supportsMultimodal?: boolean;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  description?: string | null;
}

export interface CustomProviderConfig {
  id: string;
  label: string;
  /** Persisted configuration target. Missing means legacy image config. */
  mediaType?: CustomProviderMediaType;
  baseUrl: string;
  /** Concrete endpoint path appended to baseUrl. Different vendors wildly
   *  disagree — some use /images/generations, some /create, some /v1/chat/completions.
   *  Empty → adapter falls back to its per-apiStyle default. */
  endpointPath?: string;
  /** Optional model-list endpoint. For OpenAI-compatible APIs this is usually
   *  /models when baseUrl already ends in /v1. */
  modelListEndpointPath?: string;
  /** HTTP method for the endpoint. Default POST. */
  httpMethod?: 'POST' | 'GET';
  apiKey: string;
  /** "openai" | "anthropic" | "generic-json" | "dreamina-cli" etc — freeform tag the adapter uses. */
  apiStyle: string;
  models: string[];
  supportsWebSearch: boolean;
  extraHeaders?: Record<string, string>;
  /** Extra query-string params appended to every request (e.g. api-version). */
  queryParams?: Record<string, string>;
  /** How to parse the response body into image URLs. Default 'openai-images'. */
  responseFormat?: 'openai-images' | 'url-array' | 'data-url' | 'generic';
  /** Resolutions the provider accepts, surfaced in the panel picker's 参数
   *  popover. Free-form strings so each vendor can spell their values however
   *  they like (e.g. '1k'/'2k'/'4k' or '1024x1024'/'2048x2048'). The picker
   *  passes the chosen value through as `extra_params.resolutionType`. */
  supportedResolutions?: string[];
  /** Model versions / variants the provider exposes (e.g. dreamina 4.0 / 5.0,
   *  or a vendor's "turbo" / "plus"). Picker writes to
   *  `extra_params.modelVersion`. */
  supportedModelVersions?: string[];
  /** Optional model-level metadata for text-chat providers. Kept separate from
   *  `models` so existing image/video pickers remain compatible. */
  modelMetadata?: Record<string, CustomProviderChatModelMetadata>;
  extraParams?: Record<string, unknown>;
  note?: string;
}

export function customProviderMediaType(provider: Pick<CustomProviderConfig, 'mediaType' | 'extraParams'>): CustomProviderMediaType {
  if (provider.mediaType === 'chat' || provider.extraParams?.mediaType === 'chat') {
    return 'chat';
  }
  if (provider.mediaType === 'video' || provider.extraParams?.mediaType === 'video') {
    return 'video';
  }
  return 'image';
}

export function isVideoCustomProvider(provider: Pick<CustomProviderConfig, 'mediaType' | 'extraParams'>): boolean {
  return customProviderMediaType(provider) === 'video';
}

export function isImageCustomProvider(provider: Pick<CustomProviderConfig, 'mediaType' | 'extraParams'>): boolean {
  return customProviderMediaType(provider) === 'image';
}

export function isChatCustomProvider(provider: Pick<CustomProviderConfig, 'mediaType' | 'extraParams'>): boolean {
  return customProviderMediaType(provider) === 'chat';
}

interface CustomProvidersState {
  providers: CustomProviderConfig[];
  /** ID of a provider the user asked to edit from the 我的配置 list; the
   *  添加服务商 page reads this on mount to populate its draft. */
  pendingEditId: string | null;
  addProvider: (provider: CustomProviderConfig) => void;
  updateProvider: (id: string, patch: Partial<CustomProviderConfig>) => void;
  removeProvider: (id: string) => void;
  replaceAll: (providers: CustomProviderConfig[]) => void;
  setPendingEditId: (id: string | null) => void;
}

export const useCustomProvidersStore = create<CustomProvidersState>()(
  persist(
    (set) => ({
      providers: [],
      pendingEditId: null,
      addProvider: (p) => set((s) => ({ providers: [...s.providers, p] })),
      updateProvider: (id, patch) => set((s) => ({
        providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      })),
      removeProvider: (id) => set((s) => ({ providers: s.providers.filter((p) => p.id !== id) })),
      replaceAll: (providers) => set({ providers }),
      setPendingEditId: (id) => set({ pendingEditId: id }),
    }),
    {
      name: 'custom-providers-storage',
      // Don't persist ephemeral pendingEditId across reloads.
      partialize: (s) => ({ providers: s.providers }) as unknown as CustomProvidersState,
    }
  )
);

/** Curated templates by API shape. Keep this list format-focused instead of
 *  looking like endorsements for random middlemen. */
export interface CustomProviderPreset {
  key: string;
  label: string;
  hint: string;
  template: Omit<CustomProviderConfig, 'id' | 'apiKey'>;
}

export const OPENAI_VIDEO_PROVIDER_DEFAULTS = {
  baseUrl: 'https://api.openai.com',
  endpointPath: '/v1/videos',
  modelListEndpointPath: '/v1/models',
  contentEndpointPath: '/v1/videos/{taskId}/content',
  statusEndpointPath: '/v1/videos/{taskId}',
} as const;

export const AGNES_PROVIDER_DEFAULTS = {
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  imageEndpointPath: '/images/generations',
  videoEndpointPath: '/videos',
  videoStatusEndpointPath: '/videos/{taskId}',
  chatEndpointPath: '/chat/completions',
  modelListEndpointPath: '/models',
  imageResolutions: [
    '1k',
    '2k',
    '4k',
    '1024x1024',
    '1024x768',
    '768x1024',
    '2048x2048',
    '2048x1152',
    '1152x2048',
    '4096x4096',
    '3840x2160',
    '2160x3840',
    'auto',
  ],
  videoResolutions: ['1k', '2k', '1280x720', '720x1280', '1024x1024'],
  models: {
    image21Flash: 'agnes-image-2.1-flash',
    image20Flash: 'agnes-image-2.0-flash',
    video20: 'agnes-video-v2.0',
    chat20Flash: 'agnes-2.0-flash',
    chat15Flash: 'agnes-1.5-flash',
  },
} as const;

export const CUSTOM_PROVIDER_PRESETS: CustomProviderPreset[] = [
  {
    key: 'openai_images',
    label: 'OpenAI Images 官方',
    hint: 'GPT Image / DALL-E 标准 Images API',
    template: {
      label: 'OpenAI Images',
      baseUrl: 'https://api.openai.com/v1',
      endpointPath: '/images/generations',
      modelListEndpointPath: '/models',
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'openai-images',
      models: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'chatgpt-image-latest', 'dall-e-3'],
      supportsWebSearch: false,
      supportedResolutions: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
      note: '标准 OpenAI Images 格式，通常可直接使用；图生图/编辑需确认上游是否支持 image 字段。',
    },
  },
  {
    key: 'openai_videos',
    label: 'OpenAI Videos 兼容',
    hint: 'Sora / Videos API：提交视频任务、轮询、下载 mp4',
    template: {
      label: 'OpenAI Videos',
      mediaType: 'video',
      baseUrl: OPENAI_VIDEO_PROVIDER_DEFAULTS.baseUrl,
      endpointPath: OPENAI_VIDEO_PROVIDER_DEFAULTS.endpointPath,
      modelListEndpointPath: OPENAI_VIDEO_PROVIDER_DEFAULTS.modelListEndpointPath,
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'generic',
      models: ['sora-2', 'sora-2-pro'],
      supportsWebSearch: false,
      supportedResolutions: ['1280x720', '720x1280', '1024x1024'],
      extraParams: {
        mediaType: 'video',
        supportedRatios: ['16:9', '9:16', '1:1'],
        requestBodyMode: 'multipart',
        videoStatusEndpointPath: OPENAI_VIDEO_PROVIDER_DEFAULTS.statusEndpointPath,
        videoContentEndpointPath: OPENAI_VIDEO_PROVIDER_DEFAULTS.contentEndpointPath,
        videoReferenceField: 'input_reference',
        defaultRequestParams: {
          seconds: 8,
        },
      },
      note: 'OpenAI Videos API 兼容路线：multipart/form-data 提交 model/prompt/size/seconds/input_reference，GET /v1/videos/{id} 轮询，完成后 GET /v1/videos/{id}/content 下载视频。官方文档当前标注 Sora 2 Videos API 将在 2026-09-24 关闭，保留此预设用于兼容。',
    },
  },
  {
    key: 'agnes_image_flash',
    label: 'Agnes Image Flash',
    hint: 'Agnes image 2.1 / 2.0 flash，可按文档修正 endpoint',
    template: {
      label: 'Agnes Image',
      mediaType: 'image',
      baseUrl: AGNES_PROVIDER_DEFAULTS.baseUrl,
      endpointPath: AGNES_PROVIDER_DEFAULTS.imageEndpointPath,
      modelListEndpointPath: AGNES_PROVIDER_DEFAULTS.modelListEndpointPath,
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'openai-images',
      models: [AGNES_PROVIDER_DEFAULTS.models.image21Flash, AGNES_PROVIDER_DEFAULTS.models.image20Flash],
      supportsWebSearch: false,
      supportedResolutions: [...AGNES_PROVIDER_DEFAULTS.imageResolutions],
      extraParams: {
        providerConfigVersion: 'new-v1',
        providerKind: 'agnes-images',
        supportedRatios: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
      },
      note: 'Agnes 官方网关：POST /images/generations。文生图默认 return_base64=true；图生/多图使用 extra_body.image 数组，并在 extra_body.response_format 放 b64_json。',
    },
  },
  {
    key: 'openai_proxy',
    label: 'OpenAI 兼容接口',
    hint: '绝大多数中转 / 代理 / 聚合器',
    template: {
      label: 'OpenAI 兼容接口',
      baseUrl: 'https://api.example.com/v1',
      endpointPath: '/images/generations',
      modelListEndpointPath: '/models',
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'openai-images',
      models: ['gpt-image-1', 'dall-e-3', 'nano-banana'],
      supportsWebSearch: false,
      supportedResolutions: ['auto', '1024x1024', '1536x1024', '1024x1536', '1K', '2K'],
      note: '适合兼容 OpenAI Images 返回 data[].url 或 data[].b64_json 的服务。',
    },
  },
  {
    key: 'openai_chat_image',
    label: 'Chat Completions 图像',
    hint: '部分多模态模型走 /chat/completions',
    template: {
      label: 'Chat Completions 图像',
      baseUrl: 'https://api.example.com/v1',
      endpointPath: '/chat/completions',
      modelListEndpointPath: '/models',
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'generic',
      models: ['google/gemini-2.5-flash-image', 'openai/gpt-image-1'],
      supportsWebSearch: true,
      supportedResolutions: ['auto', '0.5K', '1K', '2K'],
      note: '用于返回结构不一定是 Images API 的聊天式图像模型；保存前建议测试连通。',
    },
  },
  {
    key: 'openai_responses_image',
    label: 'Responses 图像工具',
    hint: 'OpenAI Responses API / image_generation 工具',
    template: {
      label: 'Responses 图像工具',
      baseUrl: 'https://api.example.com/v1',
      endpointPath: '/responses',
      modelListEndpointPath: '/models',
      httpMethod: 'POST',
      apiStyle: 'openai-compatible',
      responseFormat: 'generic',
      models: ['gpt-5.1', 'gpt-4.1'],
      supportsWebSearch: false,
      supportedResolutions: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      extraParams: {
        defaultRequestParams: {
          tools: [{ type: 'image_generation' }],
        },
        responseImagePath: 'output[0].result',
      },
      note: '用于 Responses API 的 image_generation 工具路线。不同兼容站返回字段可能不同，失败时可调整 responseImagePath。',
    },
  },
  {
    key: 'grsai_draw_async',
    label: 'Draw 任务轮询接口',
    hint: '提交 draw 任务，再轮询 result 拿图',
    template: {
      label: 'Draw 任务轮询接口',
      baseUrl: 'https://grsai.dakka.com.cn',
      endpointPath: '/v1/draw/completions',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: ['gpt-image-2'],
      supportsWebSearch: false,
      supportedResolutions: [],
      extraParams: {
        supportedRatios: ['auto', '1:1', '3:2', '2:3', '16:9', '9:16', '5:4', '4:5', '4:3', '3:4', '21:9', '9:21', '1:3', '3:1', '2:1', '1:2'],
        requestBodyHints: {
          promptField: 'prompt',
          modelField: 'model',
          sizeField: '',
          ratioField: 'aspectRatio',
          referenceImageField: 'urls',
        },
        responseImagePath: 'results[0].url',
        asyncTask: {
          enabled: true,
          taskIdPath: 'data.id',
          resultEndpointPath: '/v1/draw/result',
          resultMethod: 'POST',
          requestBody: { id: '{taskId}' },
          imagePath: 'results[0].url',
          statusPath: 'status',
          pendingValues: ['running', 'pending', 'queued', 'processing'],
          successValues: ['succeeded', 'success', 'completed', 'done'],
          failedValues: ['failed', 'error'],
          errorPath: 'error',
          intervalMs: 1000,
          timeoutMs: 180000,
        },
        defaultRequestParams: {
          webHook: '-1',
          shutProgress: false,
        },
      },
      note: '适合 /v1/draw/completions 这类任务型绘图接口。webHook=-1 时立即返回任务 id，再轮询 /v1/draw/result 获取 results[0].url；默认 1 秒轮询一次并允许较长生成时间。',
    },
  },
  {
    key: 'fal',
    label: '模型端点直连接口',
    hint: '每个模型一个独立 endpoint',
    template: {
      label: '模型端点直连接口',
      baseUrl: 'https://fal.run',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'fal',
      responseFormat: 'generic',
      models: ['fal-ai/flux/dev', 'fal-ai/flux-pro', 'fal-ai/nano-banana', 'fal-ai/stable-diffusion-xl'],
      supportsWebSearch: false,
      note: '适合每个模型都有独立 endpoint 的托管接口。选择模型后如无法连通，请把完整模型 endpoint 填入 baseUrl 或 endpointPath。',
    },
  },
  {
    key: 'fal_queue_async',
    label: '队列式异步任务',
    hint: 'submit/status/result 任务流',
    template: {
      label: '队列式异步任务',
      baseUrl: 'https://queue.fal.run',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'fal',
      responseFormat: 'generic',
      models: ['fal-ai/flux-pro', 'fal-ai/flux/dev', 'fal-ai/nano-banana'],
      supportsWebSearch: false,
      extraParams: {
        requestBodyHints: {
          promptField: 'prompt',
          modelField: '',
          sizeField: '',
          ratioField: 'aspect_ratio',
          referenceImageField: 'image_url',
        },
        asyncTask: {
          enabled: true,
          taskIdPath: 'request_id',
          resultEndpointPath: '/{taskId}/status',
          resultMethod: 'GET',
          imagePath: 'response.images[0].url',
          statusPath: 'status',
          pendingValues: ['IN_QUEUE', 'IN_PROGRESS'],
          successValues: ['COMPLETED', 'SUCCEEDED', 'SUCCESS'],
          failedValues: ['FAILED'],
          errorPath: 'error',
          intervalMs: 2000,
          timeoutMs: 120000,
        },
      },
      note: '适合 queue submit/status/result 这类异步任务接口；如果路径不一致，请按文档调整 resultEndpointPath。',
    },
  },
  {
    key: 'replicate_prediction_async',
    label: 'Prediction 任务接口',
    hint: '创建 prediction，再轮询结果',
    template: {
      label: 'Prediction 任务接口',
      baseUrl: 'https://api.replicate.com/v1',
      endpointPath: '/predictions',
      modelListEndpointPath: '/models',
      httpMethod: 'POST',
      apiStyle: 'replicate',
      responseFormat: 'generic',
      models: ['black-forest-labs/flux-1.1-pro', 'stability-ai/sdxl', 'google/nano-banana'],
      supportsWebSearch: false,
      extraParams: {
        requestBodyHints: {
          promptField: 'input.prompt',
          modelField: '',
          sizeField: '',
          ratioField: 'input.aspect_ratio',
          referenceImageField: 'input.image',
        },
        asyncTask: {
          enabled: true,
          taskIdPath: 'id',
          resultEndpointPath: '/predictions/{taskId}',
          resultMethod: 'GET',
          imagePath: 'output[0]',
          statusPath: 'status',
          pendingValues: ['starting', 'processing'],
          successValues: ['succeeded', 'success', 'completed'],
          failedValues: ['failed', 'canceled'],
          errorPath: 'error',
          intervalMs: 2000,
          timeoutMs: 180000,
        },
      },
      note: '适合需要 version/input 结构并轮询 prediction 的接口。导入时务必让 AI 从文档提取 version 或模型专属 endpoint。',
    },
  },
  {
    key: 'generic_async_poll',
    label: 'Generic 异步轮询',
    hint: '提交任务 ID，再轮询状态/结果',
    template: {
      label: 'Generic 异步任务',
      baseUrl: 'https://api.example.com',
      endpointPath: '/generate',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      extraParams: {
        requestBodyHints: {
          promptField: 'prompt',
          modelField: 'model',
          sizeField: 'size',
          ratioField: 'aspect_ratio',
          referenceImageField: 'image',
        },
        responseImagePath: 'result.url',
        asyncTask: {
          enabled: true,
          taskIdPath: 'id',
          resultEndpointPath: '/result/{taskId}',
          resultMethod: 'GET',
          imagePath: 'result.url',
          statusPath: 'status',
          pendingValues: ['queued', 'running', 'processing', 'pending'],
          successValues: ['succeeded', 'success', 'completed', 'done'],
          failedValues: ['failed', 'error', 'canceled'],
          errorPath: 'error',
          intervalMs: 2000,
          timeoutMs: 120000,
        },
      },
      note: '适合“先提交任务，再查结果”的通用 JSON 接口。导入后重点检查 taskIdPath、resultEndpointPath、imagePath。',
    },
  },
  {
    key: 'volc_jimeng',
    label: '云厂商签名图像接口',
    hint: '专用鉴权/Action/签名路线',
    template: {
      label: '云厂商签名图像接口',
      baseUrl: 'https://visual.volcengineapi.com',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'volcengine',
      responseFormat: 'generic',
      models: ['jimeng_t2i_v30', 'jimeng_i2i_v30', 'jimeng_t2i_v20'],
      supportsWebSearch: false,
      extraParams: {
        transport: 'signed',
        needsProxy: true,
        signedAuth: {
          required: true,
        },
      },
      note: '适合云厂商专用鉴权/请求体路线；若需要 AK/SK 签名，建议通过服务端代理后再接入。',
    },
  },
  {
    key: 'multipart_proxy_required',
    label: 'Multipart 上传接口',
    hint: '需要 multipart/form-data 文件表单',
    template: {
      label: 'Multipart 上传接口',
      baseUrl: '',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: {
          enabled: true,
          fileField: 'image',
        },
        requestBodyHints: {
          referenceImageField: 'image',
        },
      },
      note: '该服务商需要 multipart/form-data 或文件流上传。当前网关会按 multipart 发送；如还需要签名、预上传或复杂文件协议，建议通过服务端代理。',
    },
  },
  {
    key: 'form_urlencoded',
    label: 'Form URL-encoded 接口',
    hint: '需要 application/x-www-form-urlencoded 表单',
    template: {
      label: 'Form URL-encoded 接口',
      baseUrl: '',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      extraParams: {
        requestBodyMode: 'form-urlencoded',
        requestBodyHints: {
          promptField: 'prompt',
          modelField: 'model',
          sizeField: 'size',
          ratioField: 'aspect_ratio',
        },
      },
      note: '该服务商需要 application/x-www-form-urlencoded 表单。当前网关会按 URL 编码表单发送请求体。',
    },
  },
  {
    key: 'signed_proxy_required',
    label: '签名鉴权接口',
    hint: '需要 AK/SK 签名、时间戳或动作名',
    template: {
      label: '签名鉴权接口',
      baseUrl: '',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      extraParams: {
        transport: 'signed',
        needsProxy: true,
        signedAuth: {
          required: true,
        },
      },
      note: '该服务商需要签名算法、时间戳、动作名或云厂商专用鉴权。当前前端通用配置不适合保存密钥签名逻辑，建议通过后端代理。',
    },
  },
  {
    key: 'stability',
    label: 'Multipart 图像接口',
    hint: '常见于官方图像生成/编辑 API',
    template: {
      label: 'Multipart 图像接口',
      baseUrl: 'https://api.stability.ai',
      endpointPath: '/v2beta/stable-image/generate/core',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'stability',
      responseFormat: 'generic',
      models: ['stable-image-ultra', 'stable-image-core', 'stable-diffusion-3.5-large'],
      supportsWebSearch: false,
      extraHeaders: {
        Accept: 'application/json',
      },
      extraParams: {
        requestBodyMode: 'multipart',
        multipart: {
          enabled: true,
          fileField: 'image',
        },
        requestBodyHints: {
          promptField: 'prompt',
          modelField: '',
          sizeField: '',
          ratioField: 'aspect_ratio',
          referenceImageField: 'image',
        },
        responseImagePath: 'image',
        defaultRequestParams: {
          output_format: 'png',
        },
      },
      note: '适合官方图像生成/编辑 API 常见的 multipart/form-data 路线；已按 multipart 发送。若服务商返回二进制图片，请改为 JSON/base64 返回或走代理。',
    },
  },
  {
    key: 'generic_json',
    label: 'Generic JSON',
    hint: '同步 JSON 请求，自动扫描图片 URL',
    template: {
      label: 'Generic JSON',
      baseUrl: 'https://api.example.com',
      endpointPath: '/generate',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      note: '完全不符合主流格式时使用。multipart 接口请加 requestBodyMode 标记；复杂签名、预上传或专用鉴权建议走代理。',
    },
  },
  {
    key: 'manual',
    label: '其他 / 手动配置',
    hint: '空白模板，完全自己填写',
    template: {
      label: '',
      baseUrl: '',
      endpointPath: '',
      modelListEndpointPath: '',
      httpMethod: 'POST',
      apiStyle: 'generic-json',
      responseFormat: 'generic',
      models: [],
      supportsWebSearch: false,
      note: '',
    },
  },
];

/** Tutorial prompt: users paste this into their favourite AI with their actual
 *  provider doc / curl example, then paste the returned JSON back into the app
 *  for one-click import. */
export const CUSTOM_PROVIDER_TUTORIAL_PROMPT = `\
我正在一个画布类 AI 绘图应用里配置一个自定义的图像生成服务商。请你帮我把下面这段服务商文档 / cURL / 请求示例转换成一个标准的 JSON 配置，方便我一键导入。

要求：
1. 只输出纯 JSON，不要任何解释、markdown 包装或 \`\`\` 代码块。
2. 必须由你判断最合适的 templateKey，不要让我选择模板。先判断接口形态，再选模板。可选值和判断规则：
   - openai_images：OpenAI 官方 Images API。
   - openai_videos：OpenAI 官方 / 兼容 Videos API，通常是 /v1/videos，multipart/form-data 提交后轮询并下载视频。
   - openai_proxy：兼容 OpenAI Images API 的中转、代理、聚合器，通常是 /v1/images/generations，返回 data[].url 或 data[].b64_json。
   - openai_chat_image：通过 /v1/chat/completions 或兼容 Chat Completions 生成图片的模型。
   - openai_responses_image：通过 /v1/responses + image_generation 工具生成图片。
   - grsai_draw_async：GRS AI / dakka / /v1/draw/*，提交绘图任务后轮询 /v1/draw/result。
   - fal：Fal.ai / fal.run 同步 endpoint。
   - fal_queue_async：Fal queue.fal.run 异步任务。
   - replicate_prediction_async：Replicate Predictions API，创建 prediction 后轮询结果。
   - generic_async_poll：通用“提交任务 id + 轮询结果”的 JSON 接口。
   - volc_jimeng：火山引擎 / 方舟 / 即梦官方接口。
   - stability：Stability AI 官方接口。
   - multipart_proxy_required：需要 multipart/form-data、文件流上传；普通 multipart 可直连，复杂签名/预上传建议代理。
   - form_urlencoded：需要 application/x-www-form-urlencoded / x-www-form-urlencoded / urlencoded 表单，可直连。
   - signed_proxy_required：需要 AK/SK 签名、时间戳、Action、云厂商专用鉴权，建议代理。
   - generic_json：同步 JSON 请求但不属于以上主流格式，应用需要从任意 JSON 字段里扫描图片 URL。
   - manual：资料不足或完全无法判断。
3. 字段严格按这个结构，缺失的就用空字符串 / 空数组 / 空对象：
{
  "templateKey": "openai_images | openai_videos | openai_proxy | openai_chat_image | openai_responses_image | grsai_draw_async | fal | fal_queue_async | replicate_prediction_async | generic_async_poll | volc_jimeng | stability | multipart_proxy_required | form_urlencoded | signed_proxy_required | generic_json | manual",
  "templateReason": "为什么选择这个模板，说明接口属于同步 OpenAI / 异步轮询 / multipart / 签名代理等哪一类",
  "compatibility": {
    "canDirectCall": true,
    "needsProxy": false,
    "risk": "none | async-poll | stream-only | multipart | form-urlencoded | signed-auth | unknown",
    "reason": "是否能被前端 JSON 网关直接调用，以及需要注意的原因"
  },
  "requestPlan": {
    "mode": "sync-json | async-poll | stream-final-json | webhook | multipart | form-urlencoded | signed",
    "submit": "提交请求的完整格式说明，包括 URL、method、headers、body 关键字段",
    "poll": "如果需要轮询，写轮询 URL、method、body、任务 id 来源；不需要就留空",
    "requiredFields": ["model", "prompt"],
    "optionalFields": ["size", "aspect_ratio", "reference_images"]
  },
  "responsePlan": {
    "taskIdPath": "任务 id 的 JSON 路径；同步接口留空",
    "imagePath": "最终图片 URL/base64 的 JSON 路径",
    "statusPath": "状态字段路径；同步接口留空",
    "successCondition": "如何判断成功，例如 status=succeeded 或 progress=100",
    "failureCondition": "如何判断失败，例如 status=failed 或 code != 0"
  },
  "label": "服务商显示名（中文友好）",
  "baseUrl": "API 根地址，例如 https://api.example.com",
  "endpointPath": "生图接口的路径部分，例如 /v1/images/generations 或 /create 或 /v1/chat/completions；若示例里就是根地址直接打接口，把完整相对路径写在这里",
  "modelListEndpointPath": "模型列表接口路径，例如 /models；如果文档没有模型列表接口就留空",
  "httpMethod": "POST 或 GET，默认 POST",
  "apiStyle": "其中一个: openai-compatible | fal | replicate | stability | volcengine | generic-json | dreamina-cli",
  "models": ["模型ID1", "模型ID2"],
  "supportsWebSearch": false,
  "supportedRatios": ["auto", "16:9", "1:1", "9:16"],
  "supportedResolutions": ["1K", "2K", "4K"],
  "supportedModelVersions": [],
  "extraHeaders": {},
  "queryParams": {},
  "responseFormat": "openai-images | url-array | data-url | generic",
  "extraParams": {
    "requestBodyHints": {
      "promptField": "prompt",
      "modelField": "model",
      "sizeField": "size",
      "ratioField": "aspect_ratio",
      "referenceImageField": "image 或 reference_images 或 urls；支持 input.prompt 这种点路径"
    },
    "responseImagePath": "同步返回图片时填写，例如 data[0].url / images[0] / output[0] / result.image_url / results[0].url",
    "asyncTask": {
      "enabled": false,
      "taskIdPath": "提交接口返回的任务ID路径，例如 data.id / id / request_id",
      "resultEndpointPath": "轮询接口路径，例如 /v1/draw/result 或 /predictions/{taskId}；可用 {taskId} 占位",
      "resultMethod": "GET 或 POST",
      "requestBody": { "id": "{taskId}" },
      "imagePath": "轮询结果里的图片路径，例如 results[0].url / output[0] / response.images[0].url",
      "statusPath": "状态字段路径，例如 status",
      "pendingValues": ["queued", "running", "processing", "pending"],
      "successValues": ["succeeded", "success", "completed", "done"],
      "failedValues": ["failed", "error", "canceled"],
      "errorPath": "错误信息路径，例如 error 或 failure_reason",
      "intervalMs": 2000,
      "timeoutMs": 120000
    }
  },
  "note": "一句话描述本服务商的注意事项、鉴权限制、是否需要轮询、是否需要 multipart/form-data 或 x-www-form-urlencoded"
}
4. templateKey 和 apiStyle / endpointPath / responseFormat / extraParams 要互相匹配：例如 templateKey=openai_proxy 时，通常 apiStyle=openai-compatible、endpointPath=/images/generations、responseFormat=openai-images；templateKey=openai_videos 时，通常 mediaType=video、apiStyle=openai-compatible、endpointPath=/v1/videos、requestBodyMode=multipart、responseFormat=generic。
5. 如果文档里有多个可用于图像生成/编辑的模型，models 数组尽量只列图像相关模型；不要把纯文本、embedding、语音模型混进去。
6. apiStyle 选最接近的一个：OpenAI Images / Videos / 兼容中转选 openai-compatible；Fal.ai 选 fal；Replicate 选 replicate；Stability AI 选 stability；火山引擎方舟/即梦选 volcengine；完全不匹配就选 generic-json。
7. responseFormat：返回是 OpenAI Images 格式（含 data[].url / b64_json）→ openai-images；返回是纯 url 数组 → url-array；返回 base64/dataurl 字符串 → data-url；完全不规则 → generic。
8. supportedRatios：列出该服务商真实支持的生图比例；若没限制或接口参数叫「智能」「自动」等则首项填 "auto"。
9. supportedResolutions：只要文档、模型页或 cURL 示例里出现 size / resolution / quality / output_resolution / image_size 等字段，就提取成可选项，例如 ["auto", "1024x1024", "1536x1024", "1K", "2K"]；确实完全没有才留空数组。
10. modelListEndpointPath：如果服务商兼容 OpenAI，一般填 /models；如果没有模型列表接口，填空字符串。
11. extraHeaders：只填固定 header 名和值，例如 HTTP-Referer、X-Title、api-version；不要填 Authorization，应用会自动用 Bearer API Key。
12. extraParams.requestBodyHints：当接口字段名不是 model/prompt/size/aspect_ratio/reference_images 时必须填写。支持点路径，例如 Replicate 可用 input.prompt，GRS AI 可用 aspectRatio / urls。
13. extraParams.responseImagePath：同步接口必须填最准确的图片路径；异步接口则填 asyncTask.imagePath。
14. extraParams.asyncTask：只要文档里出现 task_id、id、request_id、prediction、status、result、轮询、回调、webhook，就必须启用并填完整。GET 轮询用 resultEndpointPath 的 {taskId}；POST 轮询把请求体写到 requestBody。
15. templateReason / compatibility / requestPlan / responsePlan 必须讲清楚你为什么这么配，尤其是异步接口要明确“提交拿 taskId -> 轮询拿图片”的完整链路。
16. supportedResolutions：OpenAI-compatible 的 /images/generations、/chat/completions 图像、/responses 图像工具优先写真实像素尺寸，例如 1024x1024、1536x1024、1024x1536；不要只写 1K/2K/4K，除非文档明确这么要求。
17. 如果返回图片在 choices[0].message.content 里，responseImagePath 填 choices[0].message.content；应用会从 markdown 图片、普通 URL、嵌套 JSON 字符串里继续解析。
18. extraParams.defaultRequestParams：把每次请求都需要附带的固定 JSON 参数放进去，例如 quality、style、output_format、response_format、modalities、webHook、shutProgress 等。注意字段大小写必须和官方文档一致。
19. 如果需要 multipart/form-data 或文件流上传，templateKey 选 multipart_proxy_required，并在 extraParams.requestBodyHints.referenceImageField 写清文件字段名；如果需要 application/x-www-form-urlencoded、x-www-form-urlencoded、urlencoded 或 form-urlencoded，templateKey 选 form_urlencoded，并设置 extraParams.requestBodyMode="form-urlencoded"；如果需要 AK/SK 签名、Action、时间戳签名，templateKey 选 signed_proxy_required；不要硬写成 generic_json。
20. 如果文档说默认 stream，但也提供 webHook="-1" 或类似参数让接口立即返回任务 id，再通过 result 接口轮询，那么优先配置成 async-poll，因为这更适合当前应用直连。
21. 不要填写 apiKey，我会自己在应用里填。

下面是我的服务商资料：
<<此处粘贴文档 / cURL / 请求示例>>`;
