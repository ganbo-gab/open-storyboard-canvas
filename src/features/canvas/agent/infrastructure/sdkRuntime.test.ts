import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '@openai/agents';

import {
  loadCanvasAgentSdkRuntime,
  resetCanvasAgentSdkRuntimeForTests,
} from '../application/agentRuntimeLoader';
import type {
  AgentModelReference,
  AgentModelTransport,
  AgentModelTurnRequest,
  AgentModelTurnResponse,
} from '../domain/agentModel';
import { AgentModelGatewayError } from './agentModelGateway';
import {
  StoryboardAgentModel,
  StoryboardModelProvider,
  conservativeModelRetryPolicy,
  createStoryboardAgentRuntime,
} from './sdkRuntime';

const reference: AgentModelReference = {
  catalogId: 'custom:provider:model',
  providerId: 'provider',
  modelId: 'model',
  label: 'Provider / Model',
  usable: true,
  capabilities: {
    protocol: 'openai-chat-completions',
    tools: true,
    stream: true,
    vision: true,
    reasoningSummary: true,
    toolSearch: false,
  },
};

function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemInstructions: 'Operate the canvas.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this shot.' },
        { type: 'input_image', image: 'https://assets.test/shot.png', detail: 'high' },
      ],
    }],
    modelSettings: { toolChoice: 'auto', maxTokens: 512 },
    tools: [{
      type: 'function',
      name: 'query_canvas',
      namespace: 'canvas',
      description: 'Read the canvas projection.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      strict: true,
    }],
    toolsExplicitlyProvided: true,
    outputType: 'text',
    handoffs: [],
    tracing: false,
    ...overrides,
  };
}

function response(): AgentModelTurnResponse {
  return {
    responseId: 'response-1',
    text: 'The canvas has one shot.',
    reasoningSummary: 'Inspected the projected node list.',
    toolCalls: [{
      callId: 'call-1',
      name: 'query_canvas',
      namespace: 'canvas',
      arguments: '{}',
    }],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      reasoningTokens: 2,
      cachedInputTokens: 3,
    },
    providerSummary: { protocol: 'openai-chat-completions' },
  };
}

describe('OpenAI Agents SDK runtime adapter', () => {
  it('maps SDK requests and responses through application-owned DTOs', async () => {
    let captured: AgentModelTurnRequest | null = null;
    const transport: AgentModelTransport = {
      async getResponse(requestValue) {
        captured = requestValue;
        return response();
      },
      async *getStreamedResponse() {
        yield { type: 'completed', response: response() };
      },
    };
    const model = new StoryboardAgentModel(reference, transport);
    const result = await model.getResponse(modelRequest());

    expect(captured).toMatchObject({
      model: { catalogId: 'custom:provider:model' },
      systemInstructions: 'Operate the canvas.',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this shot.' },
          { type: 'image', imageUrl: 'https://assets.test/shot.png', detail: 'high' },
        ],
      }],
      tools: [{ name: 'query_canvas', namespace: 'canvas' }],
    });
    expect(result).toMatchObject({
      responseId: 'response-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      output: [
        {
          type: 'reasoning',
          content: [{ type: 'input_text', text: 'Inspected the projected node list.' }],
        },
        { type: 'message', content: [{ type: 'output_text', text: 'The canvas has one shot.' }] },
        { type: 'function_call', callId: 'call-1', name: 'query_canvas', namespace: 'canvas' },
      ],
      providerData: { protocol: 'openai-chat-completions' },
    });
    expect(result.output[0]).not.toHaveProperty('rawContent');
  });

  it('emits standard SDK stream events and preserves a final tool response', async () => {
    const transport: AgentModelTransport = {
      async getResponse() {
        return response();
      },
      async *getStreamedResponse() {
        yield { type: 'text_delta', delta: 'The canvas ' };
        yield { type: 'reasoning_summary_delta', delta: 'Inspected nodes.' };
        yield { type: 'completed', response: response() };
      },
    };
    const events = [];
    for await (const event of new StoryboardAgentModel(reference, transport)
      .getStreamedResponse(modelRequest())) {
      events.push(event);
    }
    expect(events).toMatchObject([
      { type: 'response_started' },
      { type: 'output_text_delta', delta: 'The canvas ' },
      { type: 'model', event: { type: 'reasoning_summary_delta', delta: 'Inspected nodes.' } },
      {
        type: 'response_done',
        response: {
          id: 'response-1',
          output: [
            { type: 'reasoning' },
            { type: 'message' },
            { type: 'function_call', callId: 'call-1' },
          ],
        },
      },
    ]);
  });

  it('only retries an explicitly replay-safe model failure before stream output', async () => {
    const model = new StoryboardAgentModel(reference, {
      async getResponse() { return response(); },
      async *getStreamedResponse() { yield { type: 'completed', response: response() }; },
    });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('busy', 503, true, false),
      stream: true,
      attempt: 1,
    })).toMatchObject({ suggested: true, replaySafety: 'safe' });
    expect(model.getRetryAdvice({
      request: modelRequest(),
      error: new AgentModelGatewayError('interrupted', 503, true, true),
      stream: true,
      attempt: 1,
    })).toMatchObject({ suggested: false, replaySafety: 'unsafe' });
    expect(conservativeModelRetryPolicy({
      attempt: 1,
      maxRetries: 1,
      normalized: { isAbort: false },
      providerAdvice: { suggested: true, replaySafety: 'safe' },
    })).toBe(true);
    expect(conservativeModelRetryPolicy({
      attempt: 1,
      maxRetries: 1,
      normalized: { isAbort: false },
      providerAdvice: { suggested: true, replaySafety: 'unsafe' },
    })).toBe(false);
  });

  it('fails closed for incompatible models and creates a privacy-disabled runner', () => {
    const transport: AgentModelTransport = {
      async getResponse() { return response(); },
      async *getStreamedResponse() { yield { type: 'completed', response: response() }; },
    };
    const blocked = { ...reference, usable: false, notReadyReason: 'missing tool support' };
    expect(() => new StoryboardModelProvider({
      resolveModel: () => blocked,
      transport,
    }).getModel()).toThrow('missing tool support');

    const runtime = createStoryboardAgentRuntime({ resolveModel: () => reference, transport });
    expect(runtime.runner.config).toMatchObject({
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      modelSettings: { retry: { maxRetries: 1 } },
    });
  });

  it('loads the SDK runtime once through the dynamic boundary', async () => {
    resetCanvasAgentSdkRuntimeForTests();
    const first = loadCanvasAgentSdkRuntime();
    const second = loadCanvasAgentSdkRuntime();
    expect(first).toBe(second);
    await expect(first).resolves.toHaveProperty('StoryboardModelProvider');
  });
});
