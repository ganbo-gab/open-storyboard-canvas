// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ParameterSchemaEditor } from './ParameterSchemaEditor';
import { channelProfileSchema, type ParamSpec } from '@/features/channels/domain/profile';
import { renderRequest } from '@/features/channels/domain/template';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('edits labels and literal option types for the same request contract, including hidden defaults', async () => {
  let saved: ParamSpec[]=[];
  function Harness() { const [params,setParams]=useState<ParamSpec[]>([{key:'size',label:'size',type:'enum',options:[{label:'方形',value:'1024x1024'}],default:'1024x1024'}]);saved=params;return <ParameterSchemaEditor params={params} onChange={setParams} />; }
  render(<Harness />);
  fireEvent.click(screen.getByText('ui.channels.frameOptions.advanced', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox',{name:'参数 1 显示名称'}),{target:{value:'画面规格'}});
  const options=screen.getByRole('textbox',{name:'参数 1 选项'});
  fireEvent.change(options,{target:{value:'方形="1024x1024"\n数值文本="5"\n数值=5'}});fireEvent.blur(options);
  expect(saved[0]).toMatchObject({key:'size',label:'画面规格',options:[{value:'1024x1024'},{value:'5'},{value:5}]});
  const profile=channelProfileSchema.parse({version:2,id:'diy',name:'DIY',baseUrl:'https://example.test',auth:{type:'none'},operations:{'image.generate':{method:'POST',path:'/image',body:'json',template:{size:'{{param.size}}',callback:'{{param.callback}}'},response:{mode:'sync',outputs:[]}}},models:[{id:'image',operations:['image.generate'],params:[...saved,{key:'callback',label:'回调',type:'text',default:'-1',display:'hidden'}]}]});
  const {request}=await renderRequest(profile,{jobId:'one',channelId:'diy',modelId:'image',operation:'image.generate',prompt:'x',params:{},refs:[],count:1},'',async()=> '');
  expect(request.body).toEqual({mode:'json',json:{size:'1024x1024',callback:'-1'}});
  fireEvent.click(screen.getByRole('button',{name:'预览工作台'}));expect(screen.getByText('画面规格')).toBeTruthy();
});
