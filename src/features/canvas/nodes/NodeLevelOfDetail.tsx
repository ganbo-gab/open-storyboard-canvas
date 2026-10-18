import type { ReactNode } from 'react';
import { Handle, Position, useInternalNode, useStore } from '@xyflow/react';
import { nodeHasSourceHandle, nodeHasTargetHandle } from '../domain/nodeRegistry';
import type { CanvasNodeType } from '../domain/canvasNodes';
import { resolveImageDisplayUrl } from '../application/imageData';

type Props = { nodeId:string;children:ReactNode };
/** Below readable scale, avoid mounting editors, media players and model-selection effects. */
export function NodeLevelOfDetail({nodeId,children}:Props){
 const simplified=useStore((state)=>state.transform[2]<.4);
 const node=useInternalNode(nodeId);
 if(!simplified||!node||node.selected||node.type==='groupNode'||node.type==='tagGroupNode')return children;
 const data=node.data;const type=node.type as CanvasNodeType;
 const name=typeof data.displayName==='string'?data.displayName:node.type;
 const image=typeof data.previewImageUrl==='string'&&data.previewImageUrl?data.previewImageUrl:typeof data.imageUrl==='string'?data.imageUrl:null;
 const prompt=typeof data.prompt==='string'?data.prompt:typeof data.content==='string'?data.content:'';
 return <div className="relative flex h-full min-h-24 flex-col overflow-visible rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-bg)" style={{width:node.measured.width??node.width??320,height:node.measured.height??node.height??220}}>
  <span className="absolute -top-7 left-1 max-w-full truncate text-sm text-text-muted">{name}</span>
  {image?<img src={resolveImageDisplayUrl(image)} alt={name} draggable={false} loading="lazy" className="pointer-events-none h-full w-full rounded-xl object-cover" />:<div className="flex h-full flex-col justify-center gap-3 p-5"><span className="text-sm text-text-muted">{name}</span><p className="line-clamp-4 whitespace-pre-wrap text-sm leading-7 text-text-muted/60">{prompt}</p></div>}
  {nodeHasTargetHandle(type)&&<Handle type="target" id="target" position={Position.Left} />}
  {nodeHasSourceHandle(type)&&<Handle type="source" id="source" position={Position.Right} />}
 </div>;
}
