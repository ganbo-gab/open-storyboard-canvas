// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialRecoveryControl } from './CredentialRecoveryControl';
import { authorizeChannelJob } from '@/features/channels/runtime/channelExecution';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/channels/runtime/channelExecution', () => ({ authorizeChannelJob: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('waits for explicit authorization before querying the original task and prevents duplicate clicks', async () => {
  const authorization = Promise.withResolvers<void>();
  vi.mocked(authorizeChannelJob).mockReturnValue(authorization.promise);
  const query = vi.fn(async () => undefined);
  render(<CredentialRecoveryControl jobId="original-job" canQuery onAuthorized={query} />);
  const button = screen.getByRole('button', { name: '重新授权并查询原结果' });
  fireEvent.click(button); fireEvent.click(button);
  expect(authorizeChannelJob).toHaveBeenCalledExactlyOnceWith('original-job');
  expect(button.hasAttribute('disabled')).toBe(true); expect(query).not.toHaveBeenCalled();
  authorization.resolve();
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
});

it('keeps a denied authorization paused and allows a later explicit retry', async () => {
  vi.mocked(authorizeChannelJob).mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  const query = vi.fn(async () => undefined);
  render(<CredentialRecoveryControl jobId="original-job" canQuery onAuthorized={query} />);
  fireEvent.click(screen.getByRole('button', { name: '重新授权并查询原结果' }));
  expect((await screen.findByRole('status')).textContent).toContain('已停止查询');
  expect(query).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新授权并查询原结果' }));
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  expect(authorizeChannelJob).toHaveBeenCalledTimes(2);
});

it('authorizes a pre-submit failure without generating or querying a nonexistent upstream task', async () => {
  vi.mocked(authorizeChannelJob).mockResolvedValue(undefined);
  const query = vi.fn(async () => undefined);
  render(<CredentialRecoveryControl jobId="unsent-local-job" canQuery={false} onAuthorized={query} />);
  fireEvent.click(screen.getByRole('button', { name: '重新授权系统凭据' }));
  expect((await screen.findByRole('status')).textContent).toContain('此前请求尚未发出');
  expect(authorizeChannelJob).toHaveBeenCalledExactlyOnceWith('unsent-local-job');
  expect(query).not.toHaveBeenCalled();
});
