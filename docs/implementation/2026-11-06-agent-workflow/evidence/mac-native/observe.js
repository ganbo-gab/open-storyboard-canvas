(async()=>{
const qa=__qa,flow=__qaFlow,root=document.querySelector('.canvas-root'),vp=document.querySelector('.react-flow__viewport');
if(!window.__TAURI_INTERNALS__)throw Error('Actual Tauri required');
if(document.visibilityState!=='visible'||!document.hasFocus())throw Error('Visible focused window required');
if(qa.canvas.getState().nodes.length!==1000||qa.canvas.getState().edges.length!==1000)throw Error('Incomplete canonical fixture');
const imgs=[...document.querySelectorAll('.react-flow__node img')];const stats=qa.thumbs.stats();
if(flow.getState().transform[2]<=.10001&&(document.querySelectorAll('.react-flow__node').length!==1000||document.querySelectorAll('.canvas-edge__base').length!==1000||imgs.length!==350))throw Error('Incomplete far-zoom mounted graph');
if(stats.heavyActive||stats.heavyQueued||stats.failures||imgs.some(x=>!x.complete||!x.naturalWidth))throw Error('Media not ready');
window.__macProbe?.dispose?.();
let current=null;const completed=[];let before=null;let unsubscribe=()=>{};
const geometry=()=>new Map(qa.canvas.getState().nodes.map(n=>[n.id,[n.position.x,n.position.y]]));
const begin=e=>{
 if(e.button!==0&&e.button!==2)return;
 if(!e.target.closest?.('.react-flow__pane,.react-flow__node,.react-flow__nodesselection-rect'))return;
 before={positions:geometry(),nodes:qa.canvas.getState().nodes,edges:qa.canvas.getState().edges,history:qa.canvas.getState().history};
 current={started:performance.now(),trusted:e.isTrusted,buttons:e.buttons,events:0,trustedMoves:0,frames:[],transforms:new Set(),lastFrame:0,start:flow.getState().transform.slice(),startTarget:e.target.className};
 const active=current;function tick(t){if(current!==active)return;if(active.lastFrame)active.frames.push(t-active.lastFrame);active.lastFrame=t;active.transforms.add(vp.style.transform);requestAnimationFrame(tick)}requestAnimationFrame(tick);
};
const move=e=>{if(current){current.events++;if(e.isTrusted)current.trustedMoves++}};
const end=()=>{if(!current)return;const active=current,currentBefore=before;current=null;const duration=performance.now()-active.started;const sorted=active.frames.sort((a,b)=>a-b);requestAnimationFrame(()=>requestAnimationFrame(()=>{
 const after=qa.canvas.getState();completed.push({trusted:active.trusted,buttons:active.buttons,trustedMoves:active.trustedMoves,events:active.events,durationMs:duration,frames:sorted.length,transforms:active.transforms.size,p50:sorted[Math.floor(sorted.length*.5)]??null,p95:sorted[Math.floor(sorted.length*.95)]??null,max:sorted.length?Math.max(...sorted):null,over50:sorted.filter(x=>x>50).length,start:active.start,end:flow.getState().transform.slice(),graphStable:currentBefore.nodes===after.nodes&&currentBefore.edges===after.edges,historyDelta:after.history.past.length-currentBefore.history.past.length,changed:after.nodes.filter(n=>{const p=currentBefore.positions.get(n.id);return !p||p[0]!==n.position.x||p[1]!==n.position.y}).map(n=>n.id),visibility:document.visibilityState});
}));};
window.addEventListener('pointerdown',begin,true);window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',end,true);window.addEventListener('pointercancel',end,true);
window.__macProbe={completed,before:()=>before,dispose:()=>{window.removeEventListener('pointerdown',begin,true);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',end,true);window.removeEventListener('pointercancel',end,true);unsubscribe();current=null}};
return {tauri:true,platform:navigator.userAgent,visibility:document.visibilityState,focused:document.hasFocus(),inner:[innerWidth,innerHeight],canvas:root.getBoundingClientRect().toJSON(),dpr:devicePixelRatio,canonical:{nodes:qa.canvas.getState().nodes.length,edges:qa.canvas.getState().edges.length},mounted:{productEdges:document.querySelectorAll('.canvas-edge__base').length,flowPaths:document.querySelectorAll('.canvas-edge__flow').length,nodes:document.querySelectorAll('.react-flow__node').length,edges:document.querySelectorAll('.react-flow__edge').length,images:imgs.length},media:stats,viewport:flow.getState().transform};
})()
