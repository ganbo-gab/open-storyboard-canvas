import { useState } from 'react';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput } from '@/components/ui';
import { answerAgentUserInput, readAgentUserInputAnswer, validateAgentUserAnswers, type AgentQuestionBinding, type AgentUserInputRequest } from '@/features/canvas/agent/application/agentUserInput';
import type { AgentApprovalCardStatus } from './AgentApprovalCard';

export function AgentQuestionCard({ request, binding, status, disabled, expiresAt, onDecide }: {
  request: AgentUserInputRequest; binding: AgentQuestionBinding; status: AgentApprovalCardStatus;
  disabled: boolean; expiresAt: number; onDecide: (approve: boolean) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string>>(() => readAgentUserInputAnswer(binding, request) ?? {});
  const [custom, setCustom] = useState<Record<string, boolean>>(() => Object.fromEntries(request.questions.map(question => [question.id, Boolean(answers[question.id] && !question.options.some(option => option.value === answers[question.id]))])));
  const [error, setError] = useState('');
  const pending = status === 'pending' && Date.now() < expiresAt;
  let complete = false;
  try { validateAgentUserAnswers(request, answers); complete = true; } catch { /* Keep Continue disabled until every answer is present. */ }
  const submit = () => {
    if (disabled || !pending) return;
    try { answerAgentUserInput(binding, request, answers); onDecide(true); } catch (cause) { setError(cause instanceof Error ? cause.message : t('canvasAgent.question.invalid')); }
  };
  return <article className="agent-card agent-question-card" data-tone={pending ? 'attention' : undefined} aria-label={t('canvasAgent.question.title')}>
    <p className="agent-card__eyebrow"><MessageCircleQuestion aria-hidden="true" /><span>{t(pending ? 'canvasAgent.question.title' : status === 'approved' ? 'canvasAgent.question.answered' : status === 'approving' ? 'canvasAgent.question.continuing' : status === 'rejected' || status === 'rejecting' ? 'canvasAgent.question.cancelled' : 'canvasAgent.question.expired')}</span></p>
    {request.questions.map((question, index) => <fieldset className="mt-3 min-w-0" key={question.id} disabled={!pending || disabled}>
      <legend className="mb-2 text-sm font-medium leading-6">{request.questions.length > 1 ? `${index + 1}. ` : ''}{question.title}</legend>
      <div className="space-y-1.5">
        {question.options.map(option => <label key={option.value} className={`agent-question-option ${!custom[question.id] && answers[question.id] === option.value ? 'is-selected' : ''}`}>
          <input type="radio" className="sr-only" name={`${binding.runId}-${binding.callId}-${question.id}`} value={option.value} checked={!custom[question.id] && answers[question.id] === option.value}
            onChange={() => { setCustom(previous => ({ ...previous, [question.id]: false })); setAnswers(previous => ({ ...previous, [question.id]: option.value })); }} />
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{option.label}</span>{option.description ? <span className="mt-1 block text-[11px] leading-5 text-text-muted">{option.description}</span> : null}</span>
          {!custom[question.id] && answers[question.id] === option.value ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
        </label>)}
        {question.allowCustom ? <label className="block pt-1 text-xs text-text-muted">
          <span>{t('canvasAgent.question.custom')}</span>
          <UiInput className="mt-1 w-full" maxLength={4000} value={custom[question.id] || !question.options.length ? answers[question.id] ?? '' : ''}
            onChange={event => { setCustom(previous => ({ ...previous, [question.id]: true })); setAnswers(previous => ({ ...previous, [question.id]: event.target.value })); }} />
        </label> : null}
      </div>
    </fieldset>)}
    {error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}
    {pending ? <div className="agent-card__actions"><UiButton variant="secondary" disabled={disabled} onClick={() => onDecide(false)}>{t('canvasAgent.question.cancel')}</UiButton><UiButton variant="primary" disabled={disabled || !complete} onClick={submit}>{t('canvasAgent.question.continue')}</UiButton></div> : null}
  </article>;
}
