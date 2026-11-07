// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyBindingEditor } from './ComfyBindingEditor';

const mocks = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@/commands/ai', () => ({ customHttpRequest: mocks.http }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ComfyUI preflight authentication', () => {
  it.each(['header', 'query'])('uses the same trimmed prefix separator for %s auth as check and generation', async (mode) => {
    mocks.http.mockResolvedValue({ status: 200, text: '{"CLIPTextEncode":{"input":{"required":{"text":["STRING"]}}}}' });
    render(<ComfyBindingEditor workflowText={'{"6":{"class_type":"CLIPTextEncode","inputs":{"text":""}}}'} bindingsText="{}" outputsText="[]"
      baseUrl="workstation:8188/prompt" apiKey=" secret " auth={{ mode, name: 'access_key', prefix: 'Token' }} onBindings={vi.fn()} onOutputs={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'rework.comfy.preflight' })); });
    expect(mocks.http).toHaveBeenCalledWith(expect.objectContaining(mode === 'header'
      ? { url: 'http://workstation:8188/object_info', headers: { access_key: 'Token secret' } }
      : { url: 'http://workstation:8188/object_info?access_key=Token+secret', headers: {} }));
  });
});
