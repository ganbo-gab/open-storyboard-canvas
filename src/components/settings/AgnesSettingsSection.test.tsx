// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  verifyAgnesKey: vi.fn(),
  setAgnesApiKey: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count === undefined ? key : `${key}:${options.count}`
    ),
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

vi.mock('@/features/canvas/infrastructure/customProviderGateway', () => ({
  verifyAgnesKey: runtimeMocks.verifyAgnesKey,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: {
    agnesApiKey: string;
    setAgnesApiKey: (key: string) => void;
  }) => unknown) => selector({
    agnesApiKey: 'saved-key',
    setAgnesApiKey: runtimeMocks.setAgnesApiKey,
  }),
}));

import { AgnesSettingsSection } from './AgnesSettingsSection';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  runtimeMocks.verifyAgnesKey.mockReset();
  runtimeMocks.setAgnesApiKey.mockReset();
});

describe('AgnesSettingsSection', () => {
  it('renders save and explicit verification as separate controls', () => {
    const { container } = render(<AgnesSettingsSection />);
    expect(screen.getByRole('button', { name: 'settings.agnes.save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.agnes.verify' })).toBeTruthy();
    expect(container.textContent).not.toContain('settings.agnes.verifySuccess');
    expect(container.textContent).toContain('Agnes 2.5 Flash');
  });

  it('shows verifying and then a successful verification result', async () => {
    const result = deferred<{ ok: true; modelCount: number }>();
    runtimeMocks.verifyAgnesKey.mockReturnValueOnce(result.promise);
    render(<AgnesSettingsSection />);
    const verifyButton = screen.getByRole<HTMLButtonElement>('button', { name: 'settings.agnes.verify' });

    fireEvent.click(verifyButton);
    expect(verifyButton.textContent).toBe('settings.agnes.verifying');
    expect(verifyButton.disabled).toBe(true);

    await act(async () => { result.resolve({ ok: true, modelCount: 7 }); });
    expect(screen.getByRole('status').textContent).toContain('settings.agnes.verifySuccess:7');
  });

  it('shows a categorized failed verification result', async () => {
    runtimeMocks.verifyAgnesKey.mockResolvedValueOnce({
      ok: false,
      category: 'authorization',
    });
    render(<AgnesSettingsSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.agnes.verify' }));
    });
    expect(screen.getByRole('status').textContent).toContain('settings.agnes.verifyErrors.authorization');
  });

  it('resets on Key edits and ignores a stale verification response', async () => {
    const staleResult = deferred<{ ok: true; modelCount: number }>();
    runtimeMocks.verifyAgnesKey.mockReturnValueOnce(staleResult.promise);
    const { container } = render(<AgnesSettingsSection />);
    const input = container.querySelector('input')!;
    fireEvent.click(screen.getByRole('button', { name: 'settings.agnes.verify' }));

    fireEvent.change(input, { target: { value: 'new-key' } });
    expect(screen.queryByRole('status')).toBeNull();
    expect(runtimeMocks.verifyAgnesKey).toHaveBeenCalledWith('saved-key');

    await act(async () => { staleResult.resolve({ ok: true, modelCount: 99 }); });
    expect(container.textContent).not.toContain('settings.agnes.verifySuccess');
  });
});
