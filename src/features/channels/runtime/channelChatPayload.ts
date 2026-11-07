import type { ChannelProfileV2 } from '../domain/profile';
import { resolveModelMode } from '../application/modelModes';

type RecordValue = Record<string, unknown>;
function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as RecordValue;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}
function failField(key: string): never { throw new Error(`此文本协议适配器无法无损映射字段 ${key}；请求未发送`); }
function only(record: RecordValue, keys: readonly string[]): void {
  for (const key of Object.keys(record)) if (!keys.includes(key) && record[key] !== undefined) failField(key);
}
export type ChannelChatProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'google-gemini';
/** Protocol selection is explicit in the declared payload mapping, never a host/model heuristic. */
export function channelChatProtocol(profile: ChannelProfileV2, modelId?: string, modeId?: string): ChannelChatProtocol {
  const model = profile.models.find((entry) => modelId ? entry.id === modelId : entry.modes?.some((mode) => mode.operation === 'chat'));
  const mode = model?.modes?.find((entry) => modeId ? entry.id === modeId && entry.operation === 'chat' : entry.operation === 'chat');
  const op = model && mode ? resolveModelMode(model, mode.id).operationSpec ?? profile.operations.chat : profile.operations.chat;
  const body = object(op?.template, 'chat template');
  if (body.contents === '{{chatPayload.contents}}') return 'google-gemini';
  if (body.input === '{{chatPayload.input}}') return 'openai-responses';
  if (body.system === '{{chatPayload.system}}') return 'anthropic-messages';
  if (body.messages === '{{messages}}') return 'openai-chat-completions';
  throw new Error('渠道缺少显式的文本协议映射');
}
function parts(content: unknown): RecordValue[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return list(content, 'message.content').map((part) => object(part, 'message part'));
}
function image(part: RecordValue): { url: string; mime?: string; data?: string; detail?: unknown } {
  only(part, ['type', 'image_url']);
  const value = object(part.image_url, 'image_url'); only(value, ['url', 'detail']);
  if (typeof value.url !== 'string') throw new Error('image_url.url 无效');
  const inline = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value.url);
  return { url: value.url, ...(value.detail !== undefined ? { detail: value.detail } : {}), ...(inline ? { mime: inline[1], data: inline[2] } : {}) };
}
function toolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error('工具调用 arguments 不是有效 JSON；请求未发送'); }
}
function functions(value: unknown): RecordValue[] {
  return list(value, 'tools').map((tool) => {
    const record = object(tool, 'tool'); only(record, ['type', 'function']);
    if (record.type !== 'function') failField('tools.type');
    return object(record.function, 'tool.function');
  });
}
/** Public callers keep OpenAI messages; native Agent codecs call channelService directly. */
export function adaptChannelChatPayload(profile: ChannelProfileV2, payload: unknown, modelId?: string): RecordValue {
  const source = object(payload, '文本请求');
  const protocol = channelChatProtocol(profile, modelId, typeof source.channel_mode_id === 'string' ? source.channel_mode_id : undefined);
  if (protocol === 'openai-chat-completions') return { ...source };
  const messages = list(source.messages, 'messages').map((message) => object(message, 'message'));
  const result: RecordValue = { ...source };
  delete result.messages;
  if (protocol === 'openai-responses') {
    const input: unknown[] = [];
    for (const message of messages) {
      only(message, ['role', 'content', 'tool_calls', 'tool_call_id']);
      if (message.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }); continue;
      }
      const content = parts(message.content).map((part) => {
        if (part.type === 'text') { only(part, ['type', 'text']); return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }; }
        if (part.type === 'image_url') { const ref = image(part); return { type: 'input_image', image_url: ref.url, ...(ref.detail !== undefined ? { detail: ref.detail } : {}) }; }
        return failField(`content.${String(part.type)}`);
      });
      if (content.length) input.push({ type: 'message', role: message.role, content });
      for (const raw of message.tool_calls ? list(message.tool_calls, 'tool_calls') : []) {
        const call = object(raw, 'tool_call'); only(call, ['id', 'type', 'function']);
        const fn = object(call.function, 'function'); only(fn, ['name', 'arguments']);
        input.push({ type: 'function_call', call_id: call.id, name: fn.name, arguments: fn.arguments });
      }
    }
    result.input = input;
    if (source.max_tokens !== undefined) { result.max_output_tokens = source.max_tokens; delete result.max_tokens; }
    if (source.tools !== undefined) result.tools = functions(source.tools).map((fn) => ({ type: 'function', ...fn }));
    if (source.tool_choice && typeof source.tool_choice === 'object') {
      const choice = object(source.tool_choice, 'tool_choice'); only(choice, ['type', 'function']);
      const fn = object(choice.function, 'tool_choice.function'); only(fn, ['name']);
      result.tool_choice = { type: 'function', name: fn.name };
    }
    return result;
  }
  const system: unknown[] = []; const turns: unknown[] = []; const toolNames: Record<string, unknown> = {};
  for (const message of messages) {
    only(message, ['role', 'content', 'tool_calls', 'tool_call_id']);
    const content: RecordValue[] = parts(message.content).map((part): RecordValue => {
      if (part.type === 'text') { only(part, ['type', 'text']); return protocol === 'anthropic-messages' ? { type: 'text', text: part.text } : { text: part.text }; }
      if (part.type !== 'image_url') return failField(`content.${String(part.type)}`);
      const ref = image(part);
      if (ref.detail !== undefined && ref.detail !== 'auto') failField('image_url.detail');
      return protocol === 'anthropic-messages'
        ? { type: 'image', source: ref.data ? { type: 'base64', media_type: ref.mime, data: ref.data } : { type: 'url', url: ref.url } }
        : ref.data ? { inlineData: { mimeType: ref.mime, data: ref.data } } : { fileData: { fileUri: ref.url } };
    });
    if (message.role === 'system') { system.push(...content); continue; }
    if (message.role === 'tool') {
      if (protocol === 'anthropic-messages') turns.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }] });
      else {
        const name = toolNames[String(message.tool_call_id)];
        if (!name) failField('tool history without Gemini function name');
        let response: unknown = message.content;
        if (typeof response === 'string') { try { response = JSON.parse(response); } catch { /* Text results remain text, never discarded. */ } }
        turns.push({ role: 'user', parts: [{ functionResponse: { name, response: response && typeof response === 'object' ? response : { output: response } } }] });
      }
      continue;
    }
    for (const raw of message.tool_calls ? list(message.tool_calls, 'tool_calls') : []) {
      const call = object(raw, 'tool_call'); only(call, ['id', 'type', 'function']);
      const fn = object(call.function, 'function'); only(fn, ['name', 'arguments']);
      toolNames[String(call.id)] = fn.name;
      content.push(protocol === 'anthropic-messages'
        ? { type: 'tool_use', id: call.id, name: fn.name, input: toolArguments(fn.arguments) }
        : { functionCall: { name: fn.name, args: toolArguments(fn.arguments) } });
    }
    turns.push(protocol === 'anthropic-messages' ? { role: message.role, content }
      : { role: message.role === 'assistant' ? 'model' : 'user', parts: content });
  }
  if (protocol === 'anthropic-messages') {
    result.messages = turns;
    if (system.length) result.system = system;
    if (source.tools !== undefined) result.tools = functions(source.tools).map((fn) => {
      only(fn, ['name', 'description', 'parameters']); return { name: fn.name, description: fn.description, input_schema: fn.parameters };
    });
    if (source.tool_choice !== undefined) {
      const choice = source.tool_choice;
      result.tool_choice = typeof choice === 'string' ? { type: choice === 'required' ? 'any' : choice }
        : { type: 'tool', name: object(object(choice, 'tool_choice').function, 'tool_choice.function').name };
    }
  } else {
    result.contents = turns;
    if (system.length) result.systemInstruction = { parts: system };
    const config: RecordValue = {};
    for (const [key, target] of Object.entries({ temperature: 'temperature', top_p: 'topP', max_tokens: 'maxOutputTokens', stop: 'stopSequences' })) {
      if (source[key] !== undefined) { config[target] = key === 'stop' && typeof source[key] === 'string' ? [source[key]] : source[key]; delete result[key]; }
    }
    if (Object.keys(config).length) result.generationConfig = config;
    if (source.tools !== undefined) result.tools = [{ functionDeclarations: functions(source.tools).map((fn) => { only(fn, ['name', 'description', 'parameters']); return fn; }) }];
    if (source.tool_choice !== undefined) {
      const choice = source.tool_choice;
      const modes: Record<string, string> = { auto: 'AUTO', none: 'NONE', required: 'ANY' };
      result.toolConfig = { functionCallingConfig: typeof choice === 'string' ? { mode: modes[choice] ?? failField('tool_choice') }
        : { mode: 'ANY', allowedFunctionNames: [object(object(choice, 'tool_choice').function, 'tool_choice.function').name] } };
      delete result.tool_choice;
    }
  }
  return result;
}
