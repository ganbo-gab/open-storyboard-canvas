import type {
  AgentModelContentPart,
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentModelTurnRequest,
} from '../domain/agentModel';
import {
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
  for (const item of request.input) {
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

  for (const item of request.input) {
    if (item.type === 'message') {
      if (item.role === 'system') continue;
      messages.push({ role: item.role, content: chatContent(item.content) });
      continue;
    }
    if (item.type === 'function_call') {
      const previous = messages[messages.length - 1];
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push({
          id: item.callId,
          type: 'function',
          function: { name: wireToolName(item), arguments: item.arguments },
        });
      } else {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.callId,
            type: 'function',
            function: { name: wireToolName(item), arguments: item.arguments },
          }],
        });
      }
      continue;
    }
    messages.push({
      role: 'tool',
      tool_call_id: item.callId,
      name: wireToolName(item),
      content: item.output,
    });
    const images = imageParts(item.content);
    if (images.length) {
      messages.push({ role: 'user', content: chatContent(images) });
    }
  }
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
  for (const item of request.input) {
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
  for (const item of request.input) {
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
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: wireToolName(item), response: parseToolResult(item.output) } }],
    });
    const images = imageParts(item.content);
    if (images.length) contents.push({ role: 'user', parts: geminiParts(images) });
  }
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
