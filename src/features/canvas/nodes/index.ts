import type { NodeTypes } from '@xyflow/react';

import { AiAudioNode } from './AiAudioNode';
import { AiTextNode } from './AiTextNode';
import { AiVideoNode } from './AiVideoNode';
import { AudioNode } from './AudioNode';
import { BlueprintNode } from './BlueprintNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { JsonCardNode } from './JsonCardNode';
import { PanoramaNode } from './PanoramaNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { TagGroupNode } from './TagGroupNode';
import { TagNode } from './TagNode';
import { UploadNode } from './UploadNode';
import { VideoNode } from './VideoNode';
import { withNodeRenderErrorBoundary } from './NodeRenderErrorBoundary';

export const nodeTypes: NodeTypes = {
  aiAudioNode: withNodeRenderErrorBoundary(AiAudioNode),
  aiTextNode: withNodeRenderErrorBoundary(AiTextNode),
  aiVideoNode: withNodeRenderErrorBoundary(AiVideoNode),
  audioNode: withNodeRenderErrorBoundary(AudioNode),
  blueprintNode: withNodeRenderErrorBoundary(BlueprintNode),
  exportImageNode: withNodeRenderErrorBoundary(ImageNode),
  groupNode: withNodeRenderErrorBoundary(GroupNode),
  imageNode: withNodeRenderErrorBoundary(ImageEditNode),
  jsonCardNode: withNodeRenderErrorBoundary(JsonCardNode),
  panoramaNode: withNodeRenderErrorBoundary(PanoramaNode),
  storyboardGenNode: withNodeRenderErrorBoundary(StoryboardGenNode),
  storyboardNode: withNodeRenderErrorBoundary(StoryboardNode),
  textAnnotationNode: withNodeRenderErrorBoundary(TextAnnotationNode),
  tagNode: withNodeRenderErrorBoundary(TagNode),
  tagGroupNode: withNodeRenderErrorBoundary(TagGroupNode),
  uploadNode: withNodeRenderErrorBoundary(UploadNode),
  videoNode: withNodeRenderErrorBoundary(VideoNode),
};

export {
  AiAudioNode,
  AiTextNode,
  AiVideoNode,
  AudioNode,
  BlueprintNode,
  GroupNode,
  ImageEditNode,
  ImageNode,
  JsonCardNode,
  PanoramaNode,
  StoryboardGenNode,
  StoryboardNode,
  TextAnnotationNode,
  TagGroupNode,
  TagNode,
  UploadNode,
  VideoNode,
};
