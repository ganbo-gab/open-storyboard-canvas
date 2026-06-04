import type { NodeTypes } from '@xyflow/react';

import { AiTextNode } from './AiTextNode';
import { AiVideoNode } from './AiVideoNode';
import { BlueprintNode } from './BlueprintNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { JsonCardNode } from './JsonCardNode';
import { PanoramaNode } from './PanoramaNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { UploadNode } from './UploadNode';
import { VideoNode } from './VideoNode';

export const nodeTypes: NodeTypes = {
  aiTextNode: AiTextNode,
  aiVideoNode: AiVideoNode,
  blueprintNode: BlueprintNode,
  exportImageNode: ImageNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  jsonCardNode: JsonCardNode,
  panoramaNode: PanoramaNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  uploadNode: UploadNode,
  videoNode: VideoNode,
};

export {
  AiTextNode,
  AiVideoNode,
  BlueprintNode,
  GroupNode,
  ImageEditNode,
  ImageNode,
  JsonCardNode,
  PanoramaNode,
  StoryboardGenNode,
  StoryboardNode,
  TextAnnotationNode,
  UploadNode,
  VideoNode,
};
