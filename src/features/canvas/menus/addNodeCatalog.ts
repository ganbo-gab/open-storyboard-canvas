import type { ComponentType } from 'react';
import {
  AudioLines,
  Braces,
  Clapperboard,
  Globe2,
  ImagePlus,
  LayoutGrid,
  Sparkles,
  StickyNote,
  Tags,
  Video,
} from 'lucide-react';

import type { CanvasNodeCreateConfiguration } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

export type AddNodeGroup = 'generate' | 'content';

export interface AddNodeEntry {
  type: CanvasNodeType;
  group: AddNodeGroup;
  labelKey: string;
  hintKey: string;
  icon: ComponentType<{ className?: string }>;
  configuration?: CanvasNodeCreateConfiguration;
}

/** Curated, ordered by how often creators reach for them. Connection drops filter by type. */
export const ADD_NODE_CATALOG: AddNodeEntry[] = [
  { type: CANVAS_NODE_TYPES.imageEdit, group: 'generate', labelKey: 'rework.canvas.nodes.image', hintKey: 'rework.canvas.nodes.imageHint', icon: ImagePlus },
  { type: CANVAS_NODE_TYPES.aiVideo, group: 'generate', labelKey: 'rework.canvas.nodes.video', hintKey: 'rework.canvas.nodes.videoHint', icon: Video },
  { type: CANVAS_NODE_TYPES.aiText, group: 'generate', labelKey: 'rework.canvas.nodes.text', hintKey: 'rework.canvas.nodes.textHint', icon: Sparkles },
  { type: CANVAS_NODE_TYPES.aiAudio, group: 'generate', labelKey: 'rework.canvas.nodes.audio', hintKey: 'rework.canvas.nodes.audioHint', icon: AudioLines },
  { type: CANVAS_NODE_TYPES.storyboardGen, group: 'generate', labelKey: 'rework.canvas.nodes.storyboard', hintKey: 'rework.canvas.nodes.storyboardHint', icon: LayoutGrid },
  { type: CANVAS_NODE_TYPES.panorama, group: 'generate', labelKey: 'rework.canvas.nodes.panorama', hintKey: 'rework.canvas.nodes.panoramaHint', icon: Globe2 },
  {
    type: CANVAS_NODE_TYPES.blueprint,
    group: 'generate',
    labelKey: 'rework.canvas.nodes.stage',
    hintKey: 'rework.canvas.nodes.stageHint',
    icon: Clapperboard,
    configuration: { openDirectorStudio: true, directorStudioMode: 'flat' },
  },
  { type: CANVAS_NODE_TYPES.textAnnotation, group: 'content', labelKey: 'rework.canvas.nodes.note', hintKey: 'rework.canvas.nodes.noteHint', icon: StickyNote },
  { type: CANVAS_NODE_TYPES.jsonCard, group: 'content', labelKey: 'rework.canvas.nodes.json', hintKey: 'rework.canvas.nodes.jsonHint', icon: Braces },
  { type: CANVAS_NODE_TYPES.tagGroup, group: 'content', labelKey: 'rework.canvas.nodes.tagGroup', hintKey: 'rework.canvas.nodes.tagGroupHint', icon: Tags },
];
