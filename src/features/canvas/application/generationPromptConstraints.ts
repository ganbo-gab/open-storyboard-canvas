export interface GenerationPromptConstraintOptions {
  enabled: boolean;
  aspectRatio?: unknown;
  resolution?: unknown;
  count?: unknown;
}

function stringifyConstraintValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function appendGenerationParameterConstraints(
  prompt: string,
  options: GenerationPromptConstraintOptions
): string {
  if (!options.enabled) {
    return prompt;
  }

  const constraints = [
    stringifyConstraintValue(options.aspectRatio)
      ? `画幅比例 ${stringifyConstraintValue(options.aspectRatio)}`
      : null,
    stringifyConstraintValue(options.resolution)
      ? `分辨率/清晰度 ${stringifyConstraintValue(options.resolution)}`
      : null,
    stringifyConstraintValue(options.count)
      ? `生成张数 ${stringifyConstraintValue(options.count)}`
      : null,
  ].filter((item): item is string => Boolean(item));

  if (constraints.length === 0) {
    return prompt;
  }

  return `${prompt}\n\n参数约束：请严格遵守当前生成参数（${constraints.join('、')}），不要因为画面主体或风格描述改成其他画幅、裁切比例或清晰度。`;
}
