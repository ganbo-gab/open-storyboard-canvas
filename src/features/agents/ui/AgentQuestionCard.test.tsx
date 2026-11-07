// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { answerAgentUserInput, readAgentUserInputAnswer, requestUserInputSchema } from '@/features/canvas/agent/application/agentUserInput';
import { AgentQuestionCard } from './AgentQuestionCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const request = requestUserInputSchema.parse({ questions: [{ id: 'model', title: '选择模型', allowCustom: true, options: [
  { label: 'Model A', value: 'model-a', description: '推荐选项' }, { label: 'Model B', value: 'model-b', description: '另一选项' },
] }] });
const binding = () => ({ projectId: 'question-card', runId: crypto.randomUUID(), callId: 'choose-model' });

it('requires an answer, exposes native radio state, and submits the selected value once', () => {
  const target = binding(); const decide = vi.fn();
  render(<AgentQuestionCard request={request} binding={target} status="pending" disabled={false} expiresAt={Date.now() + 60000} onDecide={decide} />);
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'canvasAgent.question.continue' });
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect(decide).not.toHaveBeenCalled();
  const first = screen.getByRole<HTMLInputElement>('radio', { name: /Model A/ });
  const second = screen.getByRole<HTMLInputElement>('radio', { name: /Model B/ });
  fireEvent.click(first); expect(first.checked).toBe(true);
  fireEvent.click(second); expect(second.checked).toBe(true); expect(first.checked).toBe(false);
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(decide).toHaveBeenCalledExactlyOnceWith(true);
  expect(readAgentUserInputAnswer(target, request)).toEqual({ model: 'model-b' });
});

it('restores a custom answer visibly and clears radio selection when editing it', () => {
  const target = binding(); const decide = vi.fn();
  answerAgentUserInput(target, request, { model: 'Custom model' });
  render(<AgentQuestionCard request={request} binding={target} status="pending" disabled={false} expiresAt={Date.now() + 60000} onDecide={decide} />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'canvasAgent.question.custom' });
  expect(input.value).toBe('Custom model');
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => !radio.checked)).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /Model A/ }));
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'Restored and revised' } });
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => !radio.checked)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'canvasAgent.question.continue' }));
  expect(readAgentUserInputAnswer(target, request)).toEqual({ model: 'Restored and revised' });
});

it('cancels without saving or continuing an unanswered question', () => {
  const target = binding(); const decide = vi.fn();
  render(<AgentQuestionCard request={request} binding={target} status="pending" disabled={false} expiresAt={Date.now() + 60000} onDecide={decide} />);
  fireEvent.click(screen.getByRole('button', { name: 'canvasAgent.question.cancel' }));
  expect(decide).toHaveBeenCalledExactlyOnceWith(false);
  expect(readAgentUserInputAnswer(target, request)).toBeNull();
});

it.each(['rejected', 'expired', 'approved'] as const)('keeps %s questions read-only with the correct state', (status) => {
  const decide = vi.fn();
  render(<AgentQuestionCard request={request} binding={binding()} status={status} disabled={false} expiresAt={Date.now() + 60000} onDecide={decide} />);
  expect(screen.queryByRole('button', { name: 'canvasAgent.question.continue' })).toBeNull();
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(radio => radio.matches(':disabled'))).toBe(true);
  expect(screen.getByText(`canvasAgent.question.${status === 'approved' ? 'answered' : status === 'rejected' ? 'cancelled' : 'expired'}`)).toBeTruthy();
  expect(decide).not.toHaveBeenCalled();
});
