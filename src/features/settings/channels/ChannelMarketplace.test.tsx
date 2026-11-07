// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChannelMarketplace } from './ChannelMarketplace';
import type { ChannelRecord } from '@/features/channels/store/channelStore';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const channel: ChannelRecord = { origin:'native',migrationIssues:[],createdAt:1,updatedAt:1,profile:{version:2,id:'mixed',name:'My relay',baseUrl:'http://127.0.0.1',auth:{type:'none'},operations:{},models:[
  {id:'speech-one',label:'Speech',operations:['audio.generate'],params:[]},{id:'image-one',label:'Image',operations:['image.generate'],params:[]},
]} };
it('opens the selected model from the catalog with its exact owning channel', () => {
  const use = vi.fn();
  render(<ChannelMarketplace channels={[channel]} onAdd={()=>{}} onEdit={()=>{}} onDelete={()=>{}} onTry={()=>{}} onUse={use}/>);
  fireEvent.click(screen.getByRole('tab',{name:'ui.channels.market.models'}));
  fireEvent.change(screen.getByRole('textbox',{name:'ui.channels.market.search'}),{target:{value:'speech'}});
  expect(screen.queryByText('Image')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'ui.channels.market.details'}));
  fireEvent.click(screen.getByRole('button',{name:'ui.channels.market.create'}));
  expect(use).toHaveBeenCalledWith(channel,channel.profile.models[0],'audio');
  expect(screen.queryByRole('dialog')).toBeNull();
});
