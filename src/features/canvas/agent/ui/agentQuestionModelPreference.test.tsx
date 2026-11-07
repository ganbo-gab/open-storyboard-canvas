// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerAgentUserInput, requestUserInputSchema } from '../application/agentUserInput';
import { useCanvasAgentPanelStore, type AgentFeedItem } from './agentPanelStore';
import { AgentFeedCard } from './AgentFeedCard';
import { CanvasAgentDock } from './CanvasAgentDock';
import { applyAgentQuestionModelPreference } from './agentQuestionModelPreference';

const models = vi.hoisted(() => ({
  image: ['custom:channel-a-image:model', 'custom:channel-b-image:model'],
  video: ['custom:channel-a-video:model', 'custom:channel-b-video:model'],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../application/agentGenerationCatalog', () => ({ getAgentGenerationCatalog: () => ({
  image: models.image.map(modelId => ({ modelId, label: 'Shared model name' })),
  video: models.video.map(modelId => ({ modelId, label: 'Shared model name' })),
}) }));
vi.mock('@/features/canvas/application/modelCatalog', () => ({ useImageModelCatalog: () => models.image.map(id => ({ id, usable: true })) }));
vi.mock('@/features/canvas/application/videoModelCatalog', () => ({ useVideoModelCatalog: () => models.video.map(id => ({ id, usable: true })) }));
vi.mock('@/features/agents/ui/useAgentTurnSelection', () => ({ useAgentTurnSelection: () => ({ model: null, executionMode: 'auto', models: [] }) }));
vi.mock('./useExternalAgentRuntime', () => ({ useExternalAgentRuntime: () => ({ diagnostics: {}, isListening: false }) }));
vi.mock('./CanvasAgentComposer', () => ({ CanvasAgentComposer: () => null }));
vi.mock('./CanvasAgentHeader', () => ({ CanvasAgentHeader: () => null }));
vi.mock('./CanvasAgentRuntimePicker', () => ({ CanvasAgentRuntimePicker: () => null }));
vi.mock('./CanvasAgentFeedViewport', () => ({ CanvasAgentFeedViewport: () => null }));

const noop = () => {};
const projectId = 'model-question-test';
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
  useCanvasAgentPanelStore.setState({ projectId, isOpen: false, feed: [], activeSessionId: null, selectedImageModelId: null, selectedVideoModelId: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function question(options = [{ label: 'Image on channel B', value: models.image[1], description: 'Your configured model' }]) {
  return requestUserInputSchema.parse({ questions: [{ id: 'model', title: 'Choose generation model', options, allowCustom: true }] });
}
function approval(request = question()): Extract<AgentFeedItem, { kind: 'approval' }> {
  return { id: 'approval', kind: 'approval', runId: crypto.randomUUID(), approvalId: 'model-question', toolName: 'request_user_input',
    summary: 'Choose a model', arguments: request, impact: { effect: 'read', title: 'Question', summary: '', affectedNodeCount: 0, affectedEdgeCount: 0, externalSideEffect: false },
    status: 'pending', expiresAt: Date.now() + 60_000, createdAt: Date.now() };
}
function binding(item: Extract<AgentFeedItem, { kind: 'approval' }>) { return { projectId, runId: item.runId, callId: item.approvalId }; }

it('leaves both generation preferences unset when a multi-model dock is mounted', () => {
  render(<CanvasAgentDock projectId={projectId} />);
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBeNull();
  expect(useCanvasAgentPanelStore.getState().selectedVideoModelId).toBeNull();
});

it('remembers the exact selected catalog ID before continuing and keeps it on the next dock mount', () => {
  const item = approval();
  const onApproval = vi.fn(() => expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBe(models.image[1]));
  const view = render(<AgentFeedCard item={item} onApproval={onApproval} onLocate={noop} onRestoreDraft={noop} onDiagnose={noop}
    onPlanChange={noop} onPlanConfirm={noop} onPlanCancel={noop} onBudgetLimitChange={noop} onRollback={noop} />);
  fireEvent.click(screen.getByRole('radio', { name: /Image on channel B/ }));
  fireEvent.click(screen.getByRole('button', { name: 'canvasAgent.question.continue' }));
  expect(onApproval).toHaveBeenCalledExactlyOnceWith(item, true);
  view.unmount();
  render(<CanvasAgentDock projectId={projectId} />);
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBe(models.image[1]);
  expect(useCanvasAgentPanelStore.getState().selectedVideoModelId).toBeNull();
});

it('updates the video preference only for an explicitly selected video catalog ID', () => {
  const request = question([{ label: 'Video on channel B', value: models.video[1], description: '' }]);
  const item = approval(request);
  answerAgentUserInput(binding(item), request, { model: models.video[1] });
  applyAgentQuestionModelPreference(item, binding(item));
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBeNull();
  expect(useCanvasAgentPanelStore.getState().selectedVideoModelId).toBe(models.video[1]);
});

it.each([
  { label: '16:9', value: '16:9' },
  { label: 'Shared model name', value: 'Shared model name' },
  { label: 'Removed model', value: 'custom:channel-removed-image:model' },
])('does not change preferences from unrelated or unavailable answers: $label', ({ label, value }) => {
  useCanvasAgentPanelStore.setState({ selectedImageModelId: models.image[0], selectedVideoModelId: models.video[0] });
  const request = question([{ label, value, description: '' }]); const item = approval(request);
  answerAgentUserInput(binding(item), request, { model: value });
  applyAgentQuestionModelPreference(item, binding(item));
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBe(models.image[0]);
  expect(useCanvasAgentPanelStore.getState().selectedVideoModelId).toBe(models.video[0]);
});

it('does not infer model selection from custom text, a mismatched card, or a rejected decision', () => {
  const request = question(); const item = approval(request);
  answerAgentUserInput(binding(item), request, { model: models.image[0] });
  applyAgentQuestionModelPreference(item, binding(item));
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBeNull();
  answerAgentUserInput(binding(item), request, { model: models.image[1] });
  applyAgentQuestionModelPreference(item, { ...binding(item), callId: 'another-question' });
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBeNull();
  const decide = vi.fn();
  render(<AgentFeedCard item={item} onApproval={decide} onLocate={noop} onRestoreDraft={noop} onDiagnose={noop}
    onPlanChange={noop} onPlanConfirm={noop} onPlanCancel={noop} onBudgetLimitChange={noop} onRollback={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'canvasAgent.question.cancel' }));
  expect(decide).toHaveBeenCalledExactlyOnceWith(item, false);
  expect(useCanvasAgentPanelStore.getState().selectedImageModelId).toBeNull();
});
