// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentFailureNotice } from './AgentFailureNotice';
import { AgentToolStep } from './AgentToolStep';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('Agent errors disclose detail without dominating the conversation', () => {
  it('starts collapsed, shows the complete retained error on demand, and collapses again when work continues', () => {
    const detail = `Invalid stage_command arguments: ${'invalid_union '.repeat(400)}last diagnostic`;
    const { rerender } = render(<AgentFailureNotice summary="This operation was not applied." detail={detail} />);
    expect(screen.queryByText(detail)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ui.agent.showError' }));
    expect(screen.getByText(detail).textContent).toBe(detail);
    rerender(<AgentFailureNotice summary="This operation was not applied." detail={detail} compact />);
    expect(screen.queryByText(detail)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'This operation was not applied.' }));
    expect(screen.getByText(detail).textContent).toBe(detail);
  });
  it('retains failed tool diagnostics even when its separate raw detail contains only input', () => {
    const detail = `Invalid stage_command arguments: ${'issue '.repeat(300)}`.trim();
    render(<AgentToolStep title="Update stage" status="failed" failure={detail} raw={{ nodeId: 'stage' }} />);
    expect(screen.queryByText(detail)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ui.agent.showError' }));
    expect(screen.getByText(detail).textContent).toBe(detail);
  });
});
