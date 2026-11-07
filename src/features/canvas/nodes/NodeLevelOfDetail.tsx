import { useDeferredValue, type ReactNode } from 'react';
import { NodeHandles } from '../ui/NodeFrame';
import type { CanvasNodeType } from '../domain/canvasNodes';
import { parseAspectRatio } from '../application/imageData';
import { useCanvasImageThumbnail } from '../application/useCanvasImageThumbnail';
import { useCanvasNodeLevelOfDetail } from '../engine/useCanvasNodeLevelOfDetail';
import { useCanvasNodePresentation } from '../engine/useCanvasNodePresentation';

type Props = { nodeId:string;children:ReactNode };
type ImageProps = { imageUrl:string|null;previewImageUrl:string|null;aspectRatio:string|null;alt:string;width:number;height:number };
/** Far-zoom cover image from the smallest durable thumbnail that still fills the box at device pixels. */
function LevelOfDetailImage({imageUrl,previewImageUrl,aspectRatio,alt,width,height}:ImageProps){
 const image=useCanvasImageThumbnail({imageUrl,previewImageUrl,width,height,aspectRatio:aspectRatio?parseAspectRatio(aspectRatio):null,fit:'cover'});
 return image.src?<img decoding="async" src={image.src} alt={alt} draggable={false} loading="lazy" className="pointer-events-none h-full w-full rounded-xl object-cover" />:<div className="h-full w-full rounded-xl bg-(--canvas-node-media-bg)" />;
}
/** Below readable scale, avoid mounting editors, media players and model-selection effects. */
export function NodeLevelOfDetail({nodeId,children}:Props){
 const simplified=useCanvasNodeLevelOfDetail();
 const node=useCanvasNodePresentation(nodeId);
 const selected=useDeferredValue(node?.selected===true);
 if(!simplified||!node||selected||node.type==='groupNode'||node.type==='tagGroupNode')return children;
 const data=node.data;const type=node.type as CanvasNodeType;
 const name=typeof data.displayName==='string'?data.displayName:type;
 const imageUrl=typeof data.imageUrl==='string'&&data.imageUrl?data.imageUrl:null;
 const previewImageUrl=typeof data.previewImageUrl==='string'&&data.previewImageUrl?data.previewImageUrl:null;
 const prompt=typeof data.prompt==='string'?data.prompt:typeof data.content==='string'?data.content:'';
 const width=node.measured.width??node.width??320;const height=node.measured.height??node.height??220;
 return <div className="relative flex h-full min-h-24 flex-col overflow-visible rounded-xl border border-(--canvas-node-border) bg-(--canvas-node-bg)" style={{width,height}}>
  <span className="absolute -top-7 left-1 max-w-full truncate text-sm text-text-muted">{name}</span>
  {imageUrl||previewImageUrl?<LevelOfDetailImage imageUrl={imageUrl} previewImageUrl={previewImageUrl} aspectRatio={typeof data.aspectRatio==='string'?data.aspectRatio:null} alt={name} width={width} height={height} />:<div className="flex h-full flex-col justify-center gap-3 p-5"><span className="text-sm text-text-muted">{name}</span><p className="line-clamp-4 whitespace-pre-wrap text-sm leading-7 text-text-muted/60">{prompt}</p></div>}
  <NodeHandles type={type} width={width} height={height} />
 </div>;
}
