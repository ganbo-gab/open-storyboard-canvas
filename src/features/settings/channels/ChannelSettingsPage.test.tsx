// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import type * as ConfigurationAssistant from '@/features/channels/application/configurationAssistant';
import { saveChannelRecord, useChannelStore } from '@/features/channels/store/channelStore';
import { ChannelSettingsPage } from './ChannelSettingsPage';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), testModels: vi.fn(), update: vi.fn() }));
vi.mock('@/features/channels/application/channelService', async (original) => ({ ...await original<typeof import('@/features/channels/application/channelService')>(), testChannelModels: mocks.testModels, updateChannel: mocks.update }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/canvas/application/chatModelCatalog', () => ({
  useChatModelCatalog: (): ChatCatalogEntry[] => [{
    id: 'chat:docs-reader', providerId: 'chat', providerLabel: 'Provider', modelId: 'docs-reader', modelLabel: 'Docs reader',
    supportsMultimodal: false, supportsTools: false, supportsStreaming: true, supportsReasoningSummary: false, supportsToolSearch: false,
    agentProtocol: 'openai-chat-completions', usable: true,
  }],
}));
vi.mock('@/features/channels/application/configurationAssistant', async (importOriginal) => ({
  ...await importOriginal<typeof ConfigurationAssistant>(), generateChannelProfile: mocks.generate,
}));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); useChannelStore.setState({ channels: [] }); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('ChannelSettingsPage documentation upload', () => {
  it('opens the file picker from a focusable button and reads a DOCX without calling the paid assistant', async () => {
    render(<ChannelSettingsPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'ui.channels.market.add' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /rework\.channels\.method\.assistant\.title/ }));

    const upload = screen.getByRole('button', { name: 'rework.channels.uploadDoc' });
    upload.focus();
    expect(document.activeElement).toBe(upload);
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error('file input missing');
    const open = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    // A native <button> turns Enter/Space into this click; jsdom does not synthesize that activation itself.
    fireEvent.click(upload);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.contexts[0]).toBe(picker);

    const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>Base URL https://relay.example</w:t></w:r></w:p><w:p><w:r><w:t>POST /v1/images</w:t></w:r></w:p></w:body></w:document>';
    const docx = new File([zipSync({ 'word/document.xml': strToU8(xml) })], 'api.docx');
    fireEvent.change(picker, { target: { files: [docx] } });
    const docs = screen.getByPlaceholderText<HTMLTextAreaElement>('rework.channels.documentationHint');
    await waitFor(() => expect(docs.value).toBe('Base URL https://relay.example\nPOST /v1/images'));

    expect(screen.queryByText('rework.channels.analysisApprovalTitle')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'rework.channels.analyze' }));
    expect(screen.getByText('rework.channels.analysisApprovalTitle')).toBeTruthy();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

it('does not attach discovered model IDs to a different channel opened while the request was pending', async () => {
  const request = Promise.withResolvers<{ ok: true; models: string[] }>();
  mocks.testModels.mockReturnValue(request.promise);
  for (const id of ['A', 'B']) saveChannelRecord({ version:2,id,name:id,baseUrl:'http://127.0.0.1:15641',auth:{type:'none'},operations:{
    chat:{method:'POST',path:'/chat',body:'json',template:{model:'{{model}}',messages:'{{messages}}'},response:{mode:'sync',outputs:[]}},
    'models.list':{method:'GET',path:'/models',body:'none',response:{mode:'sync',outputs:[]}},
  },models:[{id:'chat',operations:['chat'],params:[]}]});
  render(<ChannelSettingsPage />);
  fireEvent.click(screen.getAllByRole('button',{name:'ui.channels.market.configure'})[0]);
  fireEvent.click(screen.getByRole('button',{name:'rework.channels.test'}));
  fireEvent.click(screen.getByRole('button',{name:'ui.channels.market.back'}));
  fireEvent.click(screen.getAllByRole('button',{name:'ui.channels.market.configure'})[1]);
  await act(async () => request.resolve({ok:true,models:['only-from-A']}));
  expect(screen.queryByRole('button',{name:'ui.channels.manage.importModels'})).toBeNull();
  expect(screen.getByRole('textbox',{name:'rework.name'}).getAttribute('value')).toBe('B');
});

it('keeps save locked while editing a draft during an outstanding credential save', async () => {
  saveChannelRecord({ version:2,id:'saved',name:'Saved',baseUrl:'http://127.0.0.1:15641',auth:{type:'none'},operations:{chat:{method:'POST',path:'/chat',body:'json',template:{messages:'{{messages}}'},response:{mode:'sync',outputs:[]}}},models:[{id:'chat',operations:['chat'],params:[]}] });
  const pending = Promise.withResolvers<void>(); mocks.update.mockReturnValue(pending.promise);
  render(<ChannelSettingsPage />);
  fireEvent.click(screen.getByRole('button',{name:'ui.channels.market.configure'}));
  const save = screen.getByRole('button',{name:'rework.channels.save'});
  fireEvent.click(save);
  fireEvent.change(screen.getByRole('textbox',{name:'rework.name'}),{target:{value:'Edited while saving'}});
  expect(save.hasAttribute('disabled')).toBe(true);
  fireEvent.click(save);
  expect(mocks.update).toHaveBeenCalledOnce();
  await act(async()=>pending.resolve());
});
