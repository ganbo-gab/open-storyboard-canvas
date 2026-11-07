import type { ChannelProfileV2 } from "../domain/profile";

/** Editable JSON audio contract. This is not an OpenAI binary speech endpoint. */
export const genericAudioProfile: ChannelProfileV2 = {
  version: 2,
  id: "generic-audio-json",
  name: "自定义音频 · JSON",
  baseUrl: "https://audio-api.example.invalid",
  auth: { type: "bearer" },
  notes: [
    "用于返回 JSON 音频地址的接口示例，请根据供应商文档确认路径、字段和结果路径。",
    "直接返回 audio/mpeg、audio/wav 等二进制音频的接口目前不能用此模板；请使用返回 URL/base64 的接口或适配服务。",
  ],
  operations: {
    "audio.generate": {
      method: "POST",
      path: "/v1/audio/generations",
      body: "json",
      template: {
        model: "{{model}}",
        input: "{{prompt}}",
        voice: "{{param.voice}}",
        speed: "{{param.speed}}",
      },
      response: {
        mode: "sync",
        outputs: [{ path: "audio_url", as: "url", kind: "audio" }],
      },
      errorPath: "error.message",
    },
  },
  models: [
    {
      id: "your-audio-model",
      label: "填写你的音频模型",
      operations: ["audio.generate"],
      params: [
        {
          key: "voice",
          label: "音色 ID",
          type: "text",
          description: "填写供应商声明的音色，不根据名称推测。",
        },
        {
          key: "speed",
          label: "语速",
          type: "number",
          min: 0.5,
          max: 2,
          step: 0.1,
          default: 1,
        },
      ],
    },
  ],
};
