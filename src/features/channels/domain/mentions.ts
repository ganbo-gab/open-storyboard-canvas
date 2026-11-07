import type { ModelSpec } from './profile';

/** Compile authoring tokens only, never arbitrary names, URLs or email addresses. */
export function compileReferenceMentions(prompt: string, dialect: ModelSpec['mention']): string {
  if (!dialect || dialect === 'natural') return prompt;
  const kinds: Record<string, 'image' | 'video' | 'audio'> = { 图: 'image', 图片: 'image', image: 'image', 视频: 'video', video: 'video', 音频: 'audio', audio: 'audio' };
  const chinese = { image: '图', video: '视频', audio: '音频' };
  return prompt.replace(/(^|[^A-Za-z0-9_@])@?(图片|图|视频|音频|image|video|audio)([1-9]\d*)(?![A-Za-z0-9_])/gi,
    (_match, before: string, token: string, index: string) => {
      const kind = kinds[token.toLowerCase()];
      return `${before}${dialect === 'zh-bare' ? '' : '@'}${dialect === 'en-at' ? kind : chinese[kind]}${index}`;
    });
}
