// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_IMAGE_HOST_SETTINGS, normalizeImageHostSettings, type ImageHostSettings } from '@/features/settings/imageHostSettings';
import { ImageHostSection } from './ImageHostSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

function Editor({ initial = DEFAULT_IMAGE_HOST_SETTINGS, changed }: { initial?: ImageHostSettings; changed: (value: ImageHostSettings) => void }) {
  const [value, setValue] = useState(initial);
  return <ImageHostSection value={value} onChange={(next) => { setValue(next); changed(next); }} />;
}

describe('custom image-host settings workflow', () => {
  it('opens with an empty endpoint and explicit disabled switch, then edits upload fields', () => {
    const changed = vi.fn();
    render(<Editor changed={changed} />);
    const input = screen.getByLabelText('settings.imageHosting.uploadUrl');
    expect(input.getAttribute('value')).toBe('');
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.change(input, { target: { value: 'https://uploads.example/my-endpoint' } });
    fireEvent.change(screen.getByLabelText('settings.imageHosting.fileField'), { target: { value: 'image' } });
    fireEvent.change(screen.getByLabelText('settings.imageHosting.responseUrlPath'), { target: { value: 'data.image.url' } });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ enabled: false, uploadUrl: 'https://uploads.example/my-endpoint', fileField: 'image', responseUrlPath: 'data.image.url' });
  });
  it('adds protected header input and enables only when the user chooses the switch', () => {
    const changed = vi.fn();
    render(<Editor changed={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.imageHosting.addHeader' }));
    const credential = screen.getByLabelText('settings.imageHosting.headerValue 1');
    expect(credential.getAttribute('type')).toBe('password');
    fireEvent.change(credential, { target: { value: 'Bearer user-token' } });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ enabled: false, extraHeaders: { Authorization: 'Bearer user-token' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(changed.mock.lastCall?.[0].enabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'settings.imageHosting.removeHeader 1' }));
    expect(changed.mock.lastCall?.[0].extraHeaders).toEqual({});
  });
  it('shows a disabled migrated endpoint as a reviewable draft without email/password login fields', () => {
    render(<Editor changed={vi.fn()} initial={normalizeImageHostSettings({ enabled: true, provider: 'seedvault', seedvault: { apiBaseUrl: 'https://my-host.example/api' } })} />);
    expect(screen.getByRole('status').textContent).toContain('settings.imageHosting.migration.custom-endpoint');
    expect(screen.getByRole('status').textContent).toContain('https://my-host.example/api');
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText(/email|password/i)).toBeNull();
  });
});
