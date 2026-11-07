// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/canvas/application/chatModelCatalog', () => ({ useChatModelCatalog: () => [{ id: 'text-model', usable: true, providerLabel: 'Fixture', modelLabel: 'Text' }], buildChatModelCatalog: () => [] }));
vi.mock('@/features/settings/imageHostConfigurationAssistant', async (original) => ({ ...await original<typeof import('@/features/settings/imageHostConfigurationAssistant')>(), suggestImageHostConfiguration: vi.fn() }));
import { suggestImageHostConfiguration } from '@/features/settings/imageHostConfigurationAssistant';
import { DEFAULT_IMAGE_HOST_SETTINGS } from '@/features/settings/imageHostSettings';
import { ImageHostConfigurationAssistant } from './ImageHostConfigurationAssistant';

const suggestion = { uploadUrl: 'https://uploads.example/upload', fileField: 'image', responseUrlPath: 'data.url', headerNames: ['Authorization'], explanation: '使用上传接口。' };
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function chooseModel() {
  fireEvent.click(screen.getByRole('button', { name: '用于分析的文本模型' }));
  fireEvent.click(screen.getByRole('option', { name: 'Fixture · Text' }));
}

it('requires an explicit analysis click, previews the response and only applies a disabled draft on a second click', async () => {
  vi.mocked(suggestImageHostConfiguration).mockResolvedValue(suggestion);
  const current = { ...DEFAULT_IMAGE_HOST_SETTINGS, enabled: true, extraHeaders: { Authorization: 'saved-value' } };
  const onChange = vi.fn();
  render(<ImageHostConfigurationAssistant value={current} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 帮我配置图床' }));
  fireEvent.change(screen.getByRole('textbox', { name: '公开图床文档' }), { target: { value: 'Public upload documentation' } });
  chooseModel();
  expect(suggestImageHostConfiguration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认并分析一次' }));
  expect(await screen.findByText(suggestion.uploadUrl)).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '应用到配置草稿' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false, uploadUrl: suggestion.uploadUrl, extraHeaders: current.extraHeaders }));
  expect(suggestImageHostConfiguration).toHaveBeenCalledOnce();
});

it('discards an analysis if settings changed while the model was replying', async () => {
  const pending = Promise.withResolvers<typeof suggestion>();
  vi.mocked(suggestImageHostConfiguration).mockReturnValue(pending.promise);
  const current = { ...DEFAULT_IMAGE_HOST_SETTINGS, extraHeaders: {} }; const onChange = vi.fn();
  const view = render(<ImageHostConfigurationAssistant value={current} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 帮我配置图床' }));
  fireEvent.change(screen.getByRole('textbox', { name: '公开图床文档' }), { target: { value: 'Public docs' } }); chooseModel();
  fireEvent.click(screen.getByRole('button', { name: '确认并分析一次' }));
  view.rerender(<ImageHostConfigurationAssistant value={{ ...current, fileField: 'user-edited' }} onChange={onChange} />);
  await act(async () => { pending.resolve(suggestion); await pending.promise; });
  expect(screen.queryByRole('button', { name: '应用到配置草稿' })).toBeNull();
  expect(onChange).not.toHaveBeenCalled(); expect(suggestImageHostConfiguration).toHaveBeenCalledOnce();
});
