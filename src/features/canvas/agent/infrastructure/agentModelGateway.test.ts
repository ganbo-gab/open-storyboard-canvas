import { describe, expect, it } from 'vitest';

import type {
  AgentModelProtocol,
  AgentModelReference,
  AgentModelStreamEvent,
  AgentModelTurnRequest,
  AgentProviderHttpClient,
  AgentProviderHttpRequest,
  AgentProviderHttpResponse,
} from '../domain/agentModel';
import { buildAgentProviderBody } from '../application/agentProviderRequestCodec';
import { AgentModelGatewayError, createAgentModelTransport } from './agentModelGateway';

function model(
  protocol: AgentModelProtocol,
  overrides: Partial<AgentModelReference['capabilities']> = {},
): AgentModelReference {
  return {
    catalogId: `custom:provider:${protocol}`,
    providerId: 'provider',
    modelId: `fixture-${protocol}`,
    label: `Fixture ${protocol}`,
    usable: true,
    capabilities: {
      protocol,
      tools: true,
      stream: true,
      vision: true,
      reasoningSummary: true,
      toolSearch: false,
      ...overrides,
    },
  };
}

function request(reference: AgentModelReference): AgentModelTurnRequest {
  return {
    model: reference,
    systemInstructions: 'Use tools when needed.',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'Create a node.' }],
    }],
    tools: [{
      name: 'create_node',
      namespace: 'canvas',
      description: 'Create one canvas node.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      strict: true,
    }],
    toolChoice: 'auto',
  };
}

class FixtureHttpClient implements AgentProviderHttpClient {
  readonly requests: AgentProviderHttpRequest[] = [];

  constructor(
    private readonly response: AgentProviderHttpResponse,
    private readonly chunks: string[],
  ) {}

  async request(requestValue: AgentProviderHttpRequest): Promise<AgentProviderHttpResponse> {
    this.requests.push(requestValue);
    return this.response;
  }

  async *stream(requestValue: AgentProviderHttpRequest): AsyncIterable<string> {
    this.requests.push(requestValue);
    for (const chunk of this.chunks) yield chunk;
  }
}

function transport(client: AgentProviderHttpClient) {
  return createAgentModelTransport({
    httpClient: client,
    resolveConnection: (reference) => ({
      providerId: reference.providerId,
      modelId: reference.modelId,
      url: 'https://provider.test/v1/model',
      headers: { Authorization: 'Bearer top-secret-value' },
      timeoutMs: 30_000,
      defaultRequestParams: { user: 'storyboard-copilot' },
    }),
  });
}

async function collect(iterable: AsyncIterable<AgentModelStreamEvent>): Promise<AgentModelStreamEvent[]> {
  const events: AgentModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('agent model provider gateway', () => {
  it('normalizes an OpenAI Responses text and tool round without leaking credentials', async () => {
    const client = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'resp-1',
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'I will create it.' }],
          },
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'canvas__create_node',
            arguments: '{"title":"Shot 1"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      }),
    }, []);
    const result = await transport(client).getResponse(request(model('openai-responses')));

    expect(result).toMatchObject({
      responseId: 'resp-1',
      text: 'I will create it.',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      toolCalls: [{
        callId: 'call-1',
        name: 'create_node',
        namespace: 'canvas',
        arguments: '{"title":"Shot 1"}',
      }],
    });
    expect(client.requests[0].body).toMatchObject({
      model: 'fixture-openai-responses',
      user: 'storyboard-copilot',
      tools: [{ name: 'canvas__create_node' }],
    });
    expect(JSON.stringify(client.requests[0].body)).not.toContain('top-secret-value');
    expect(JSON.stringify(result)).not.toContain('top-secret-value');
  });

  it('streams OpenAI Responses text and a complete tool call', async () => {
    const chunks = [
      'data: {"type":"response.created","response":{"id":"resp-stream"}}\n',
      'data: {"type":"response.output_text.delta","delta":"Working"}\n',
      'data: {"type":"response.output_item.added","item":{"id":"item-1","type":"function_call","call_id":"call-1","name":"canvas__create_node","arguments":""}}\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"title\\":\\"Shot 2\\"}"}\n',
      'data: [DONE]\n',
    ];
    const events = await collect(transport(new FixtureHttpClient({ status: 200, text: '{}' }, chunks))
      .getStreamedResponse(request(model('openai-responses'))));

    expect(events[0]).toEqual({ type: 'text_delta', delta: 'Working' });
    expect(events[events.length - 1]).toMatchObject({
      type: 'completed',
      response: {
        responseId: 'resp-stream',
        text: 'Working',
        toolCalls: [{
          callId: 'call-1',
          name: 'create_node',
          namespace: 'canvas',
          arguments: '{"title":"Shot 2"}',
        }],
      },
    });
  });

  it('normalizes OpenAI-compatible Chat Completions text and tool fixtures', async () => {
    const nonStreaming = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'chat-1',
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: 'Checking the canvas.',
            tool_calls: [{
              id: 'call-chat',
              type: 'function',
              function: { name: 'canvas__create_node', arguments: '{"title":"Shot 3"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      }),
    }, []);
    const result = await transport(nonStreaming).getResponse(request(model('openai-chat-completions')));
    expect(result).toMatchObject({
      text: 'Checking the canvas.',
      finishReason: 'tool_calls',
      toolCalls: [{ callId: 'call-chat', name: 'create_node', namespace: 'canvas' }],
    });

    const streaming = new FixtureHttpClient({ status: 200, text: '' }, [
      'data: {"id":"chat-stream","choices":[{"index":0,"delta":{"content":"Checking "}}]}\n',
      'data: {"id":"chat-stream","choices":[{"index":0,"delta":{"content":"now","tool_calls":[{"index":0,"id":"call-stream","function":{"name":"canvas__create_node","arguments":"{\\"title\\":"}}]}}]}\n',
      'data: {"id":"chat-stream","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Shot 4\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(transport(streaming)
      .getStreamedResponse(request(model('openai-chat-completions'))));
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', delta: 'Checking ' },
      { type: 'text_delta', delta: 'now' },
    ]);
    expect(events[events.length - 1]).toMatchObject({
      type: 'completed',
      response: {
        text: 'Checking now',
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        toolCalls: [{
          callId: 'call-stream',
          name: 'create_node',
          namespace: 'canvas',
          arguments: '{"title":"Shot 4"}',
        }],
      },
    });
  });

  it('fails closed for malformed tool streams and unsupported model capabilities', async () => {
    const malformed = new FixtureHttpClient({ status: 200, text: '' }, [
      'data: {"id":"chat-bad","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-bad","function":{"name":"canvas__create_node","arguments":"{\\"title\\":"}}]}}]}\n',
      'data: [DONE]\n',
    ]);
    await expect(collect(transport(malformed)
      .getStreamedResponse(request(model('openai-chat-completions')))))
      .rejects.toThrow('Tool arguments must be a JSON object');

    const noTools = request(model('openai-chat-completions', { tools: false }));
    await expect(transport(malformed).getResponse(noTools)).rejects.toThrow('不支持工具调用');

    const noVision = request(model('openai-chat-completions', { vision: false }));
    noVision.input = [{
      type: 'message',
      role: 'user',
      content: [{ type: 'image', imageUrl: 'https://assets.test/shot.png' }],
    }];
    await expect(transport(malformed).getResponse(noVision)).rejects.toThrow('不支持图片输入');
  });

  it('encodes approved tool image results for every supported provider protocol', () => {
    const inlineImage = 'data:image/png;base64,aGVsbG8=';
    const requestWithToolImage = (protocol: AgentModelProtocol): AgentModelTurnRequest => ({
      ...request(model(protocol)),
      input: [
        {
          type: 'function_call',
          callId: 'asset-call',
          name: 'asset_read',
          arguments: '{"assetId":"node-1:image"}',
        },
        {
          type: 'function_call_result',
          callId: 'asset-call',
          name: 'asset_read',
          output: '{"assetId":"node-1:image"}',
          content: [
            { type: 'text', text: '{"assetId":"node-1:image"}' },
            { type: 'image', imageUrl: inlineImage, detail: 'auto' },
          ],
        },
      ],
    });

    const responses = buildAgentProviderBody(requestWithToolImage('openai-responses'), false);
    expect(responses.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', output: '{"assetId":"node-1:image"}' }),
      expect.objectContaining({
        type: 'message',
        role: 'user',
        content: [expect.objectContaining({ type: 'input_image', image_url: inlineImage })],
      }),
    ]));

    const chat = buildAgentProviderBody(requestWithToolImage('openai-chat-completions'), false);
    expect(chat.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: '{"assetId":"node-1:image"}' }),
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: inlineImage }) })],
      }),
    ]));

    const anthropic = buildAgentProviderBody(requestWithToolImage('anthropic-messages'), false);
    expect(anthropic.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({
          type: 'tool_result',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: '{"assetId":"node-1:image"}' }),
            expect.objectContaining({
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
            }),
          ]),
        })],
      }),
    ]));

    const gemini = buildAgentProviderBody(requestWithToolImage('google-gemini'), false);
    expect(gemini.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        parts: [expect.objectContaining({ functionResponse: expect.any(Object) })],
      }),
      expect.objectContaining({
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }],
      }),
    ]));
  });

  it('redacts credentials and payloads from transport errors', async () => {
    const secretToken = 'sk-private-agent-token';
    const querySecret = 'query-secret-value';
    const inlinePayload = 'data:image/png;base64,aGVsbG8=';
    const longPayload = 'A'.repeat(220);
    const failingClient: AgentProviderHttpClient = {
      async request(): Promise<AgentProviderHttpResponse> {
        throw new Error(
          `Authorization: Bearer ${secretToken} https://provider.test?api_key=${querySecret} `
          + `${inlinePayload} ${longPayload}`,
        );
      },
      async *stream(): AsyncIterable<string> {
        throw new Error('unused');
      },
    };

    const failure = transport(failingClient).getResponse(request(model('openai-responses')));
    await expect(failure).rejects.not.toThrow(secretToken);
    await expect(failure).rejects.not.toThrow(querySecret);
    await expect(failure).rejects.not.toThrow(inlinePayload);
    await expect(failure).rejects.not.toThrow(longPayload);
    await expect(failure).rejects.toThrow('[redacted]');
  });

  it('preserves an explicit quota-exhausted provider error for retry policy classification', async () => {
    const client = new FixtureHttpClient({
      status: 429,
      text: JSON.stringify({
        error: {
          message: 'You exceeded your current quota, please check your plan and billing details.',
          type: 'insufficient_quota',
        },
      }),
    }, []);

    await expect(transport(client).getResponse(request(model('openai-chat-completions', { stream: false }))))
      .rejects.toThrow('exceeded your current quota');
  });

  it('uses non-stream fallback and propagates AbortSignal cancellation', async () => {
    const fallbackClient = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'chat-fallback',
        choices: [{ message: { content: 'One response' }, finish_reason: 'stop' }],
      }),
    }, []);
    const events = await collect(transport(fallbackClient).getStreamedResponse(
      request(model('openai-chat-completions', { stream: false })),
    ));
    expect(events).toMatchObject([
      { type: 'text_delta', delta: 'One response' },
      { type: 'completed', response: { text: 'One response' } },
    ]);

    const cancellableClient: AgentProviderHttpClient = {
      async request(): Promise<AgentProviderHttpResponse> {
        return { status: 200, text: '{}' };
      },
      async *stream(_requestValue, signal): AsyncIterable<string> {
        yield 'data: {"id":"chat-cancel","choices":[{"index":0,"delta":{"content":"partial"}}]}\n';
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          const timer = setTimeout(resolve, 5_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      },
    };
    const controller = new AbortController();
    const iterator = transport(cancellableClient)
      .getStreamedResponse(request(model('openai-chat-completions')), controller.signal)
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text_delta', delta: 'partial' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('falls back once to non-stream when an OpenAI-compatible stream fails before output', async () => {
    const requests: AgentProviderHttpRequest[] = [];
    const client: AgentProviderHttpClient = {
      async request(requestValue) {
        requests.push(requestValue);
        return {
          status: 200,
          text: JSON.stringify({
            id: 'chat-fallback',
            choices: [{ message: { content: 'Recovered response' }, finish_reason: 'stop' }],
          }),
        };
      },
      async *stream(requestValue) {
        requests.push(requestValue);
        throw new AgentModelGatewayError('The quota has been exceeded.', 429, true, false);
      },
    };

    const events = await collect(transport(client)
      .getStreamedResponse(request(model('openai-chat-completions'))));

    expect(requests).toHaveLength(2);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Recovered response' },
      expect.objectContaining({
        type: 'completed',
        response: expect.objectContaining({
          text: 'Recovered response',
          providerSummary: expect.objectContaining({ transportFallback: 'non-stream' }),
        }),
      }),
    ]);
  });

  it('falls back once when a provider closes a successful stream without text or tools', async () => {
    const client = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'chat-empty-fallback',
        choices: [{ message: { content: 'Non-stream response' }, finish_reason: 'stop' }],
      }),
    }, ['data: [DONE]\n']);

    const events = await collect(transport(client)
      .getStreamedResponse(request(model('openai-chat-completions'))));

    expect(client.requests).toHaveLength(2);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'Non-stream response' },
      expect.objectContaining({ type: 'completed', response: expect.objectContaining({ text: 'Non-stream response' }) }),
    ]);
  });

  it('uses provider-specific named tool choice wire shapes', () => {
    const responses = buildAgentProviderBody({
      ...request(model('openai-responses')),
      toolChoice: 'create_node',
    }, false);
    expect(responses.tool_choice).toEqual({ type: 'function', name: 'canvas__create_node' });

    const chat = buildAgentProviderBody({
      ...request(model('openai-chat-completions')),
      toolChoice: 'create_node',
    }, false);
    expect(chat.tool_choice).toEqual({
      type: 'function',
      function: { name: 'canvas__create_node' },
    });

    const anthropic = buildAgentProviderBody({
      ...request(model('anthropic-messages')),
      toolChoice: 'create_node',
    }, false);
    expect(anthropic.tool_choice).toEqual({ type: 'tool', name: 'canvas__create_node' });

    const gemini = buildAgentProviderBody({
      ...request(model('google-gemini')),
      toolChoice: 'create_node',
    }, false);
    expect(gemini.toolConfig).toEqual({
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['canvas__create_node'],
      },
    });
  });

  it('emits Responses tool search, namespaces, and deferred functions only for compatible models', () => {
    const compatible: AgentModelTurnRequest = {
      ...request(model('openai-responses', { toolSearch: true })),
      tools: [{
        ...request(model('openai-responses')).tools[0],
        namespaceDescription: 'Canvas tools.',
        deferLoading: true,
      }],
      toolPolicy: {
        mode: 'responses-tool-search',
        deferredToolNames: ['canvas.create_node'],
        deferredNamespaces: ['canvas'],
      },
    };
    expect(buildAgentProviderBody(compatible, false).tools).toEqual([
      { type: 'tool_search' },
      {
        type: 'namespace',
        name: 'canvas',
        description: 'Canvas tools.',
        tools: [expect.objectContaining({
          type: 'function',
          name: 'create_node',
          defer_loading: true,
        })],
      },
    ]);

    const unsupportedResponses = {
      ...compatible,
      model: model('openai-responses', { toolSearch: false }),
    };
    expect(buildAgentProviderBody(unsupportedResponses, false).tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'canvas__create_node' }),
    ]);
    expect(JSON.stringify(buildAgentProviderBody(unsupportedResponses, false).tools)).not.toContain('defer_loading');

    const chat = { ...compatible, model: model('openai-chat-completions', { toolSearch: true }) };
    expect(buildAgentProviderBody(chat, false).tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'canvas__create_node' }),
      }),
    ]);
    expect(JSON.stringify(buildAgentProviderBody(chat, false).tools)).not.toContain('tool_search');
    expect(JSON.stringify(buildAgentProviderBody(chat, false).tools)).not.toContain('defer_loading');
  });

  it('normalizes Anthropic and Gemini tools without exposing hidden thinking', async () => {
    const anthropicClient = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'msg-anthropic',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'private chain of thought' },
          { type: 'text', text: 'I will inspect the shot.' },
          {
            type: 'tool_use',
            id: 'tool-anthropic',
            name: 'canvas__create_node',
            input: { title: 'Anthropic shot' },
          },
        ],
        usage: { input_tokens: 9, output_tokens: 5 },
      }),
    }, []);
    const anthropic = await transport(anthropicClient)
      .getResponse(request(model('anthropic-messages')));
    expect(anthropic).toMatchObject({
      text: 'I will inspect the shot.',
      toolCalls: [{
        callId: 'tool-anthropic',
        name: 'create_node',
        namespace: 'canvas',
        arguments: '{"title":"Anthropic shot"}',
      }],
    });
    expect(anthropic.reasoningSummary).toBeUndefined();
    expect(JSON.stringify(anthropic)).not.toContain('private chain of thought');

    const geminiClient = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'Creating the shot.' },
              { functionCall: { id: 'tool-gemini', name: 'canvas__create_node', args: { title: 'Gemini shot' } } },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4, totalTokenCount: 10 },
      }),
    }, []);
    const gemini = await transport(geminiClient).getResponse(request(model('google-gemini')));
    expect(gemini).toMatchObject({
      text: 'Creating the shot.',
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      toolCalls: [{
        callId: 'tool-gemini',
        name: 'create_node',
        namespace: 'canvas',
        arguments: '{"title":"Gemini shot"}',
      }],
    });
  });

  it('fails closed when a provider prints an available tool call as Markdown', async () => {
    const client = new FixtureHttpClient({
      status: 200,
      text: JSON.stringify({
        id: 'chat-textual-tool',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '准备创建节点。\n\ncanvas__create_node({"title":"Not executed"})',
          },
        }],
      }),
    }, []);
    await expect(transport(client).getResponse(request(model('openai-chat-completions'))))
      .rejects.toThrow('普通文本返回');
  });
});
