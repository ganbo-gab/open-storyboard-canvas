import type {
  AgentModelContentPart,
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentModelTurnRequest,
} from '../domain/agentModel';
import {
  getPath,
  parseToolArguments,
  wireToolName,
  type JsonRecord,
} from './agentProviderCodecUtils';

function textFromParts(parts: readonly AgentModelContentPart[]): string {
  return parts
    .filter((part): part is Extract<AgentModelContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function imageParts(parts: readonly AgentModelContentPart[] | undefined): Extract<AgentModelContentPart, { type: 'image' }>[] {
  return parts?.filter((part): part is Extract<AgentModelContentPart, { type: 'image' }> => part.type === 'image') ?? [];
}

function dataImage(value: string): { mediaType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/i);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function systemInstructions(request: AgentModelTurnRequest): string | undefined {
  const systemMessages = request.input
    .filter((item): item is Extract<AgentModelInputItem, { type: 'message' }> => (
      item.type === 'message' && item.role === 'system'
    ))
    .map((item) => textFromParts(item.content))
    .filter(Boolean);
  const combined = [request.systemInstructions, ...systemMessages].filter(Boolean).join('\n\n').trim();
  return combined || undefined;
}

function openAiResponsesInput(request: AgentModelTurnRequest): unknown[] {
  const nativeToolSearch = request.model.capabilities.protocol === 'openai-responses'
    && request.model.capabilities.toolSearch
    && request.toolPolicy?.mode === 'responses-tool-search';
  const input: unknown[] = [];
  const replayed: string[] = [];
  for (const item of request.input) {
    if ((item.type === 'function_call' || (item.type === 'message' && item.role === 'assistant')) && item.continuation?.kind === 'responses-output' && item.responseGroup) {
      if (!replayed.includes(item.responseGroup)) { input.push(...item.continuation.items); replayed.push(item.responseGroup); }
      continue;
    }
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      const content = item.content.map((part) => {
        if (part.type === 'image') {
          return {
            type: 'input_image',
            image_url: part.imageUrl,
            ...(part.detail ? { detail: part.detail } : {}),
          };
        }
        return {
          type: item.role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text,
        };
      });
      input.push({ type: 'message', role: item.role, content });
      continue;
    }
    if (item.type === 'function_call') {
      input.push({
        type: 'function_call',
        call_id: item.callId,
        name: nativeToolSearch ? item.name : wireToolName(item),
        ...(nativeToolSearch && item.namespace ? { namespace: item.namespace } : {}),
        arguments: item.arguments,
      });
      continue;
    }
    input.push({
      type: 'function_call_output',
      call_id: item.callId,
      output: item.output,
    });
    const images = imageParts(item.content);
    if (images.length) {
      input.push({
        type: 'message',
        role: 'user',
        content: images.map((part) => ({
          type: 'input_image',
          image_url: part.imageUrl,
          ...(part.detail ? { detail: part.detail } : {}),
        })),
      });
    }
  }
  return input;
}

function chatContent(parts: readonly AgentModelContentPart[]): string | unknown[] {
  if (parts.every((part) => part.type === 'text')) return textFromParts(parts);
  return parts.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : {
      type: 'image_url',
      image_url: {
        url: part.imageUrl,
        ...(part.detail ? { detail: part.detail } : {}),
      },
    });
}

function openAiChatMessages(request: AgentModelTurnRequest): JsonRecord[] {
  const messages: JsonRecord[] = [];
  const instructions = systemInstructions(request);
  if (instructions) messages.push({ role: 'system', content: instructions });
  let lastGroup: string | undefined;
  const deferredImages: AgentModelContentPart[][] = [];
  const flushToolImages = () => {
    for (const images of deferredImages) messages.push({ role: 'user', content: chatContent(images) });
    deferredImages.length = 0;
  };
  for (const item of request.input) {
    // A Chat Completions assistant's complete tool-result batch must precede
    // any ordinary message. Asset images are carried as user content, so hold
    // them until all contiguous results have been written, without reordering
    // the results themselves or moving images across an assistant turn.
    if (item.type !== 'function_call_result') flushToolImages();
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      messages.push({ role: item.role, content: chatContent(item.content),
        ...(item.role === 'assistant' && item.continuation?.kind === 'chat-reasoning' ? { reasoning_content: item.continuation.reasoningContent } : {}) });
      lastGroup = item.role === 'assistant' ? item.responseGroup : undefined;
      continue;
    }
    if (item.type === 'function_call') {
      const previous = messages[messages.length - 1];
      const call = { id: item.callId, type: 'function', function: { name: wireToolName(item), arguments: item.arguments } };
      const sameResponse = item.responseGroup ? item.responseGroup === lastGroup : Array.isArray(previous?.tool_calls);
      if (previous?.role === 'assistant' && sameResponse) {
        previous.tool_calls = [...(Array.isArray(previous.tool_calls) ? previous.tool_calls : []), call];
        if (item.continuation?.kind === 'chat-reasoning') previous.reasoning_content = item.continuation.reasoningContent;
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call],
          ...(item.continuation?.kind === 'chat-reasoning' ? { reasoning_content: item.continuation.reasoningContent } : {}) });
      }
      lastGroup = item.responseGroup;
      continue;
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, name: wireToolName(item), content: item.output });
    lastGroup = undefined;
    const images = imageParts(item.content);
    if (images.length) deferredImages.push(images);
  }
  flushToolImages();
  return messages;
}

function anthropicContent(parts: readonly AgentModelContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const inline = dataImage(part.imageUrl);
    return {
      type: 'image',
      source: inline
        ? { type: 'base64', media_type: inline.mediaType, data: inline.data }
        : { type: 'url', url: part.imageUrl },
    };
  });
}

function anthropicMessages(request: AgentModelTurnRequest): JsonRecord[] {
  const messages: JsonRecord[] = [];
  const replayed: string[] = [];
  for (const item of request.input) {
    if ((item.type === 'function_call' || (item.type === 'message' && item.role === 'assistant')) && item.continuation?.kind === 'anthropic-content' && item.responseGroup) {
      if (!replayed.includes(item.responseGroup)) { messages.push({ role: 'assistant', content: item.continuation.items }); replayed.push(item.responseGroup); }
      continue;
    }
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      messages.push({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: anthropicContent(item.content),
      });
      continue;
    }
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: item.callId,
          name: wireToolName(item),
          input: parseToolArguments(item.arguments),
        }],
      });
      continue;
    }
    const content = item.content?.length ? anthropicContent(item.content) : item.output;
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: item.callId, content }],
    });
  }
  return messages;
}

function geminiParts(parts: readonly AgentModelContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text };
    const inline = dataImage(part.imageUrl);
    return inline
      ? { inlineData: { mimeType: inline.mediaType, data: inline.data } }
      : { fileData: { fileUri: part.imageUrl, mimeType: 'image/*' } };
  });
}

function parseToolResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { result: value };
  }
}

function geminiContents(request: AgentModelTurnRequest): JsonRecord[] {
  const contents: JsonRecord[] = [];
  const replayed: string[] = [];
  const resultParts: unknown[] = [];
  const resultImages: AgentModelContentPart[] = [];
  const flushToolResults = () => {
    if (resultParts.length) contents.push({ role: 'user', parts: [...resultParts, ...geminiParts(resultImages)] });
    resultParts.length = 0;
    resultImages.length = 0;
  };
  for (const item of request.input) {
    // Gemini parallel function responses belong to one user turn. Ordinary
    // image parts follow every response in that turn, never between them.
    if (item.type !== 'function_call_result') flushToolResults();
    if ((item.type === 'function_call' || (item.type === 'message' && item.role === 'assistant')) && item.continuation?.kind === 'gemini-parts' && item.responseGroup) {
      if (!replayed.includes(item.responseGroup)) { contents.push({ role: 'model', parts: item.continuation.items }); replayed.push(item.responseGroup); }
      continue;
    }
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      contents.push({
        role: item.role === 'assistant' ? 'model' : 'user',
        parts: geminiParts(item.content),
      });
      continue;
    }
    if (item.type === 'function_call') {
      contents.push({
        role: 'model',
        parts: [{ functionCall: { name: wireToolName(item), args: parseToolArguments(item.arguments) } }],
      });
      continue;
    }
    const call = request.input.find(entry => entry.type === 'function_call' && entry.callId === item.callId);
    const nativeId = call?.type === 'function_call' && call.continuation?.kind === 'gemini-parts'
      && call.continuation.items.some(part => getPath(part, ['functionCall', 'id']) === item.callId) ? item.callId : undefined;
    resultParts.push({ functionResponse: { ...(nativeId ? { id: nativeId } : {}), name: wireToolName(item), response: parseToolResult(item.output) } });
    resultImages.push(...imageParts(item.content));
  }
  flushToolResults();
  return contents;
}

function providerTools(request: AgentModelTurnRequest): unknown[] {
  return request.tools.map((tool) => {
    const name = wireToolName(tool);
    if (request.model.capabilities.protocol === 'anthropic-messages') {
      return { name, description: tool.description, input_schema: tool.parameters };
    }
    if (request.model.capabilities.protocol === 'google-gemini') {
      return { name, description: tool.description, parameters: tool.parameters };
    }
    if (request.model.capabilities.protocol === 'openai-chat-completions') {
      return {
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      };
    }
    return {
      type: 'function',
      name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    };
  });
}

function openAiResponsesTools(request: AgentModelTurnRequest): unknown[] {
  const supportsNativeToolSearch = request.model.capabilities.protocol === 'openai-responses'
    && request.model.capabilities.toolSearch
    && request.toolPolicy?.mode === 'responses-tool-search';
  if (!supportsNativeToolSearch) return providerTools(request);

  const topLevel: unknown[] = [];
  const namespaces = new Map<string, { description: string; tools: unknown[] }>();
  for (const tool of request.tools) {
    const definition = {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
      ...(tool.deferLoading ? { defer_loading: true } : {}),
    };
    if (!tool.namespace) {
      topLevel.push(definition);
      continue;
    }
    const description = tool.namespaceDescription?.trim() || tool.namespace;
    const current = namespaces.get(tool.namespace) ?? { description, tools: [] };
    current.tools.push(definition);
    namespaces.set(tool.namespace, current);
  }
  return [
    { type: 'tool_search' },
    ...topLevel,
    ...Array.from(namespaces, ([name, namespace]) => ({
      type: 'namespace',
      name,
      description: namespace.description,
      tools: namespace.tools,
    })),
  ];
}

function selectedWireToolName(
  value: string,
  tools: readonly AgentModelToolDefinition[],
): string {
  const selected = tools.find((tool) => wireToolName(tool) === value || tool.name === value);
  return selected ? wireToolName(selected) : value;
}

function openAiResponsesToolChoice(
  value: AgentModelTurnRequest['toolChoice'],
  tools: readonly AgentModelToolDefinition[],
): unknown {
  if (!value || value === 'auto' || value === 'required' || value === 'none') return value;
  return { type: 'function', name: selectedWireToolName(value, tools) };
}

function openAiChatToolChoice(
  value: AgentModelTurnRequest['toolChoice'],
  tools: readonly AgentModelToolDefinition[],
): unknown {
  if (!value || value === 'auto' || value === 'required' || value === 'none') return value;
  return {
    type: 'function',
    function: { name: selectedWireToolName(value, tools) },
  };
}

function anthropicToolChoice(
  value: AgentModelTurnRequest['toolChoice'],
  tools: readonly AgentModelToolDefinition[],
): unknown {
  if (!value || value === 'auto') return { type: 'auto' };
  if (value === 'required') return { type: 'any' };
  if (value === 'none') return { type: 'none' };
  return { type: 'tool', name: selectedWireToolName(value, tools) };
}

function geminiToolChoice(
  value: AgentModelTurnRequest['toolChoice'],
  tools: readonly AgentModelToolDefinition[],
): unknown {
  if (!value || value === 'auto') return { mode: 'AUTO' };
  if (value === 'required') return { mode: 'ANY' };
  if (value === 'none') return { mode: 'NONE' };
  return {
    mode: 'ANY',
    allowedFunctionNames: [selectedWireToolName(value, tools)],
  };
}

export function buildAgentProviderBody(
  request: AgentModelTurnRequest,
  stream: boolean,
): JsonRecord {
  const { protocol } = request.model.capabilities;
  const tools = protocol === 'openai-responses'
    ? openAiResponsesTools(request)
    : providerTools(request);
  if (protocol === 'openai-responses') {
    return {
      model: request.model.modelId,
      input: openAiResponsesInput(request),
      ...(systemInstructions(request) ? { instructions: systemInstructions(request) } : {}),
      ...(tools.length ? { tools } : {}),
      ...(request.toolChoice
        ? { tool_choice: openAiResponsesToolChoice(request.toolChoice, request.tools) }
        : {}),
      ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
      stream,
    };
  }
  if (protocol === 'anthropic-messages') {
    return {
      model: request.model.modelId,
      messages: anthropicMessages(request),
      max_tokens: request.maxOutputTokens ?? 8192,
      ...(systemInstructions(request) ? { system: systemInstructions(request) } : {}),
      ...(tools.length ? { tools } : {}),
      ...(request.toolChoice ? { tool_choice: anthropicToolChoice(request.toolChoice, request.tools) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      stream,
    };
  }
  if (protocol === 'google-gemini') {
    return {
      contents: geminiContents(request),
      ...(systemInstructions(request)
        ? { systemInstruction: { parts: [{ text: systemInstructions(request) }] } }
        : {}),
      ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      ...(request.toolChoice
        ? { toolConfig: { functionCallingConfig: geminiToolChoice(request.toolChoice, request.tools) } }
        : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.topP !== undefined ? { topP: request.topP } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      },
    };
  }
  return {
    model: request.model.modelId,
    messages: openAiChatMessages(request),
    ...(tools.length ? { tools } : {}),
    ...(request.toolChoice
      ? { tool_choice: openAiChatToolChoice(request.toolChoice, request.tools) }
      : {}),
    ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}
