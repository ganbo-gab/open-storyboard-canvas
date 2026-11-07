import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sdk from '../infrastructure/sdkRuntime';
import type { StoryboardModelProviderOptions } from '../infrastructure/sdkRuntime';
import type { AgentModelTurnRequest, AgentModelTurnResponse } from '../domain/agentModel';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { cancelCanvasAgentRun, resolveCanvasAgentApproval, runCanvasAgentTurn } from './canvasAgentController';
import { answerAgentUserInput, requestUserInputSchema } from './agentUserInput';
import { canvasAgentApprovalStore } from './agentApproval';

const modelTransport = vi.hoisted(() => ({ response: vi.fn() }));
vi.mock('./agentRuntimeLoader', () => ({ loadCanvasAgentSdkRuntime: async () => ({
  ...sdk, createStoryboardAgentRuntime: (options: StoryboardModelProviderOptions) => sdk.createStoryboardAgentRuntime({ ...options,
    transport: { getResponse: modelTransport.response, async *getStreamedResponse() { throw new Error('Not streamed'); } },
  }),
}) }));
const model: ChatCatalogEntry = { id: 'custom:questions:deepseek-flash', providerId: 'questions', providerLabel: 'Questions', modelId: 'deepseek-flash',
  modelLabel: 'DeepSeek', supportsMultimodal: false, supportsTools: true, supportsStreaming: false, supportsReasoningSummary: false,
  supportsToolSearch: false, agentProtocol: 'openai-chat-completions', usable: true };
const request = requestUserInputSchema.parse({ questions: [{ id: 'model', title: '选择生成模型', allowCustom: false,
  options: [{ label: 'GPT Image 2.6', value: 'custom:configured-image:gpt-image-2.6', description: '已接入的图片模型' }] }] });
let runId: string | undefined;

beforeEach(() => {
  modelTransport.response.mockReset().mockImplementation(async (input: AgentModelTurnRequest): Promise<AgentModelTurnResponse> => {
    const answer = input.input.find((item) => item.type === 'function_call_result' && item.name === 'request_user_input');
    return { responseId: crypto.randomUUID(), toolCalls: answer ? [] : [{ callId: 'choose-model', name: 'request_user_input', arguments: JSON.stringify(request) }],
      text: answer ? '已收到模型选择。' : undefined, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  });
  useCanvasStore.setState({ nodes: [], edges: [], history: { past: [], future: [] }, revision: 0, dragHistorySnapshot: null });
  useProjectStore.setState({ currentProjectId: 'question-project', saveCurrentProject: vi.fn(), waitForProjectPersistence: vi.fn(async () => {}) });
});
afterEach(() => {
  if (runId) { cancelCanvasAgentRun(runId); canvasAgentApprovalStore.deleteRun(runId); }
  runId = undefined;
});

it.each(['manual', 'auto', 'full'] as const)('waits for an explicit question answer in %s mode and resumes only once', async (executionMode) => {
  const first = await runCanvasAgentTurn({ projectId: 'question-project', model, executionMode, message: '帮我生成图片' });
  runId = first.runId;
  expect(first.status).toBe('awaiting-approval');
  expect(first.approvals).toEqual([expect.objectContaining({ toolName: 'request_user_input', id: 'choose-model' })]);
  expect(modelTransport.response).toHaveBeenCalledOnce();
  expect(useCanvasStore.getState().nodes).toEqual([]);
  await expect(resolveCanvasAgentApproval({ runId: first.runId, approvalId: 'choose-model', approve: true, model })).rejects.toThrow(/回答问题/);
  expect(() => answerAgentUserInput({ projectId: 'question-project', runId: first.runId, callId: 'choose-model' }, request, { model: 'invented-model' })).toThrow();
  const binding = { projectId: 'question-project', runId: first.runId, callId: 'choose-model' };
  answerAgentUserInput(binding, request, { model: request.questions[0].options[0].value });
  const completed = await resolveCanvasAgentApproval({ runId: first.runId, approvalId: 'choose-model', approve: true, model });
  expect(completed.status).toBe('completed');
  expect(completed.finalText).toBe('已收到模型选择。');
  expect(modelTransport.response).toHaveBeenCalledTimes(2);
  const secondRequest = modelTransport.response.mock.calls[1][0] as AgentModelTurnRequest;
  expect(secondRequest.input).toContainEqual(expect.objectContaining({ type: 'function_call_result', name: 'request_user_input',
    output: expect.stringContaining(request.questions[0].options[0].value) }));
  // Repeated card delivery/submit keeps the completed result and does not invoke
  // the provider again or turn an answer into another generation submission.
  answerAgentUserInput(binding, request, { model: request.questions[0].options[0].value });
  const repeated = await resolveCanvasAgentApproval({ runId: first.runId, approvalId: 'choose-model', approve: true, model });
  expect(repeated.status).toBe('completed');
  expect(modelTransport.response).toHaveBeenCalledTimes(2);
  expect(useCanvasStore.getState().nodes).toEqual([]);
});
