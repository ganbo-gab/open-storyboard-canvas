// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProfileV2 } from '@/features/channels/domain/profile';
import { openAIStandardProfile } from '@/features/channels/presets/openai';
import { geminiNativeProfile } from '@/features/channels/presets/gemini';
import { ChannelTemplateHelp } from './ChannelTemplateHelp';
import { ChannelTemplateBrowser } from './ChannelTemplateBrowser';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`,
}) }));
vi.mock('./ChannelTemplateConnection', () => ({ ChannelTemplateConnection: ({ template }: { template: ChannelProfileV2 }) => <div role="region" aria-label="Connection form">{template.name}</div> }));

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('template connection guidance', () => {
  it('shows the actual OpenAI pixel field and raw options without changing the preset', () => {
    const before = structuredClone(openAIStandardProfile);
    render(<ChannelTemplateHelp profile={openAIStandardProfile} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('POST /v1/images/generations')).toBeTruthy();
    expect(screen.getByText(/ui.channels.templateHelp.pixels size/)).toBeTruthy();
    expect(screen.queryByText(/ui.channels.templateHelp.nativeSize/)).toBeNull();
    fireEvent.click(screen.getByText('ui.channels.templateHelp.parametersTitle'));
    expect(screen.getByText(/1024x1024 = "1024x1024"/)).toBeTruthy();
    expect(openAIStandardProfile).toEqual(before);
  });

  it('describes Gemini nested ratio and resolution fields independently of pixel sizes', () => {
    render(<ChannelTemplateHelp profile={geminiNativeProfile} />);
    expect(screen.getByText(/ui.channels.templateHelp.nativeSize generationConfig.imageConfig.aspectRatio \/ generationConfig.imageConfig.imageSize/)).toBeTruthy();
    expect(screen.queryByText(/ui.channels.templateHelp.pixels/)).toBeNull();
    expect(screen.getByText('ui.channels.templateHelp.manualModels')).toBeTruthy();
    fireEvent.click(screen.getByText('ui.channels.templateHelp.parametersTitle'));
    expect(screen.getByText(/1K = "1K".*2K = "2K"/)).toBeTruthy();
  });

  it('uses mode-specific routes and nested duration mappings, preserving the declared value type', () => {
    const profile: ChannelProfileV2 = {
      version: 2, id: 'custom-video', name: 'Custom video', baseUrl: 'https://example.test', auth: { type: 'none' }, operations: {},
      models: [{ id: 'custom-model', operations: ['video.generate'], params: [], modes: [{
        id: 'clip', label: 'Clip', operation: 'video.generate', endpoint: {
          method: 'POST', path: '/custom/clips', body: 'json', template: { parameters: { duration: '{{param.output.duration}}', resolution: '{{param.output.resolution}}' } },
          response: { mode: 'async', taskIdPath: 'id', poll: { method: 'GET', path: '/custom/clips/{{taskId}}', intervalSec: 5, timeoutMin: 10, success: ['done'], failure: ['failed'], outputs: [] } },
        }, params: [{ key: 'output', label: 'Duration and resolution', type: 'enum', options: [{ label: '8 seconds', value: { duration: 8, resolution: '720p' } }] }],
      }] }],
    };
    render(<ChannelTemplateHelp profile={profile} />);
    expect(screen.getByText('POST /custom/clips')).toBeTruthy();
    expect(screen.getByText('ui.channels.templateHelp.poll GET /custom/clips/{{taskId}}')).toBeTruthy();
    expect(screen.getByText('ui.channels.templateHelp.time')).toBeTruthy();
    fireEvent.click(screen.getByText('ui.channels.templateHelp.parametersTitle'));
    expect(screen.getByText('parameters.duration ← output.duration / parameters.resolution ← output.resolution')).toBeTruthy();
    expect(screen.getByText('8 seconds = {"duration":8,"resolution":"720p"}')).toBeTruthy();
  });

  it('opens help without connecting a model and keeps it available while filling the connection', async () => {
    const choose = vi.fn();
    render(<ChannelTemplateBrowser onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.templateHelp.openFor OpenAI 标准' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('POST /v1/images/generations')).toBeTruthy();
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getAllByRole('button', { name: '填写连接信息' })[0]);
    expect(screen.getByRole('region', { name: 'Connection form' }).textContent).toBe('OpenAI 标准');
    fireEvent.click(screen.getByRole('button', { name: 'ui.channels.templateHelp.open' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Connection form' }).textContent).toBe('OpenAI 标准');
    expect(choose).not.toHaveBeenCalled();
  });
});
