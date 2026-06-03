import type { NodeTypes } from '@xyflow/react';

import { AiVideoNode } from './AiVideoNode';
import { BlueprintNode } from './BlueprintNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { PanoramaNode } from './PanoramaNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { UploadNode } from './UploadNode';
import { VideoNode } from './VideoNode';

export const nodeTypes: NodeTypes = {
  aiVideoNode: AiVideoNode,
  blueprintNode: BlueprintNode,
  exportImageNode: ImageNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  panoramaNode: PanoramaNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  uploadNode: UploadNode,
  videoNode: VideoNode,
};

export { AiVideoNode, BlueprintNode, GroupNode, ImageEditNode, ImageNode, PanoramaNode, StoryboardGenNode, StoryboardNode, TextAnnotationNode, UploadNode, VideoNode };
