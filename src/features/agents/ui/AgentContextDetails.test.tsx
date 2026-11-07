// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentContextDetails } from './AgentContextDetails';
import type { AgentContextUsage } from '@/features/canvas/agent/application/agentContextUsage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const usage: AgentContextUsage = { requestId: 'request', modelId: 'model-a', measuredAt: 1, usedTokens: 12000,
  breakdown: { system: 2000, tools: 5000, conversation: 5000, media: 0 }, basis: 'provider', cachedTokens: 10000, outputTokens: 100, images: 0 };

it('hides the previous model usage after switching models in the same session', () => {
  const view = render(<AgentContextDetails usage={usage} contextWindow={100000} modelId="model-a" />);
  expect(screen.getByText(/12%/)).toBeTruthy();
  view.rerender(<AgentContextDetails usage={usage} contextWindow={200000} modelId="model-b" draftTokens={300} />);
  expect(screen.getByText('canvasAgent.context.empty')).toBeTruthy();
  expect(screen.queryByText(/12%|6%|12K/)).toBeNull();
  expect(screen.queryByText('canvasAgent.context.providerNote')).toBeNull();
});
