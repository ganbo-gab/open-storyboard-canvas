import { templateVariables, type ChannelProfileV2, type OperationKind, type OperationSpec } from '../domain/profile';

/** Retain only primitive leaves explicitly referenced by poll/result templates.
 * Never cache or persist the upstream response object, auth headers, or input media.
 */
export function captureSubmitSnapshot(profile: ChannelProfileV2, operation: OperationKind, payload: unknown, credential: string, operationSpec?: OperationSpec): Record<string, unknown> {
  const op = operationSpec ?? profile.operations[operation];
  if (op?.response.mode !== 'async') return {};
  const poll = op.response.poll;
  const variables = [...new Set([poll.path, poll.template, poll.resultRequest?.path, poll.resultRequest?.template,
    ...poll.outputs.flatMap((output) => 'url' in output ? [output.url] : [])].flatMap(templateVariables)
    .filter((variable) => variable.startsWith('submit.')))];
  const snapshot: Record<string, unknown> = {};
  for (const variable of variables) {
    const keys = variable.slice(7).split('.');
    if (keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key) || /key|token|secret|authorization|cookie|password|credential/i.test(key))) {
      throw new Error(`轮询引用包含敏感字段，不能持久化：${variable}`);
    }
    let value: unknown = payload;
    for (const key of keys) value = value && typeof value === 'object' && Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key] : undefined;
    if (value === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`轮询快照只允许标量字段：${variable}`);
    if (typeof value === 'string') {
      if (value.length > 4096 || /^data:|^blob:/i.test(value) || (credential && value.includes(credential))) throw new Error(`轮询字段含敏感或过大数据：${variable}`);
      if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        if (url.origin !== new URL(profile.baseUrl).origin || url.username || url.password
          || [...url.searchParams.keys()].some((key) => /key|token|secret|signature|credential|password/i.test(key))
          || (credential && [...url.searchParams.values()].some((entry) => entry.includes(credential)))) {
          throw new Error(`轮询 URL 不可安全持久化：${variable}`);
        }
      }
    }
    let target = snapshot;
    keys.forEach((key, index) => {
      if (index === keys.length - 1) target[key] = value;
      else { target[key] ??= {}; target = target[key] as Record<string, unknown>; }
    });
  }
  return snapshot;
}
