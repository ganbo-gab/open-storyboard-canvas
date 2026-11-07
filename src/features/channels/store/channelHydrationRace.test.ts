import { afterEach, expect, it, vi } from 'vitest';
const gate=vi.hoisted(()=>({promise:Promise.resolve(true)}));
vi.mock('@/features/secrets/secretStore',async original=>{
 const mod=await original<typeof import('@/features/secrets/secretStore')>();
 return {...mod,secretStore:{...mod.secretStore,has:vi.fn(()=>gate.promise)}};
});
afterEach(()=>vi.unstubAllGlobals());
it('does not let a fast legacy projection overwrite native channels while credential hydration is delayed',async()=>{
 const pending=Promise.withResolvers<boolean>();gate.promise=pending.promise;
 const profile={version:2,id:'saved-new-channel',name:'Saved native',baseUrl:'https://api.example.test',auth:{type:'bearer'},operations:{chat:{method:'POST',path:'/v1/chat/completions',body:'json',template:{messages:'{{messages}}'},response:{mode:'sync',outputs:[]}}},models:[{id:'deepseek-flash',operations:['chat'],params:[]}]};
 const saved=JSON.stringify({version:2,state:{channels:[{profile,credentialRef:{namespace:'channel',id:'hydration-race-ref'},origin:'native',migrationIssues:[],createdAt:1,updatedAt:2}],migratedLegacyIds:[]}});
 const legacy={id:'legacy-image',label:'Old image',baseUrl:'https://old.example.test',apiKey:'',apiStyle:'openai-compatible',models:['image'],supportsWebSearch:false};
 const values=new Map([['channels-v2-storage',saved],['custom-providers-storage',JSON.stringify({version:0,state:{providers:[legacy]}})]]);
 const writes: string[]=[];
 vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);if(key==='channels-v2-storage')writes.push(value);},removeItem:(key:string)=>values.delete(key)});
 const {useChannelStore,migrateLegacyProviders,channelStoresHydrated}=await import('./channelStore');
 await import('@/stores/customProvidersStore');
 const {secretStore}=await import('@/features/secrets/secretStore');
 await vi.waitFor(()=>expect(secretStore.has).toHaveBeenCalled());
 expect(channelStoresHydrated()).toBe(false);
 migrateLegacyProviders([legacy]);
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(values.get('channels-v2-storage')).toBe(saved);expect(writes).toEqual([]);
 pending.resolve(true);
 await vi.waitFor(()=>expect(channelStoresHydrated()).toBe(true));
 await vi.waitFor(()=>expect(useChannelStore.getState().channels.map(row=>row.profile.id)).toEqual(expect.arrayContaining(['saved-new-channel','legacy-image'])));
 await vi.waitFor(()=>expect(values.get('channels-v2-storage')).toContain('saved-new-channel'));
 expect(writes.every(value=>value.includes('saved-new-channel'))).toBe(true);
});
