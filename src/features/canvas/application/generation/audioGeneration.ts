import { t } from 'i18next';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import { collectInputReferences } from '../graphReferenceResolver';
import { GenerationInputError } from './types';
import { assembleChannelAudioRequest, executeChannelAudioRequest, type ChannelAudioRequestAssembly } from './channelAudioGeneration';
import { renderPreview } from '@/features/channels/domain/template';
import { generationCanvasMutations } from './canvasMutations';

export type AudioRequestAssembly = ChannelAudioRequestAssembly;
export function previewAudioRequest(assembled: AudioRequestAssembly): unknown {
  return renderPreview(assembled.profile, assembled.input);
}

/** Text and connected notes remain inputs; all model behavior comes from the selected channel. */
export function assembleAudioRequest(id: string): AudioRequestAssembly {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== CANVAS_NODE_TYPES.aiAudio) throw new GenerationInputError('unsupported', 'Audio generator does not exist');
  const parts = collectInputReferences(id, state.nodes, state.edges)
    .flatMap((reference) => reference.kind === 'text' && reference.content ? [reference.content] : []);
  const prompt = typeof node.data.prompt === 'string' ? node.data.prompt : '';
  const text = [...parts, prompt].map((part) => part.replace(/\r\n/g, '\n').trim()).filter(Boolean).join('\n\n');
  if (!text) throw new GenerationInputError('invalid-input', t('node.aiAudio.textRequired'));
  try { return assembleChannelAudioRequest(id, text); }
  catch (error) {
    if (error instanceof GenerationInputError) throw error;
    throw new GenerationInputError('invalid-input', error instanceof Error ? error.message : String(error));
  }
}

function audioInputHash(assembled: AudioRequestAssembly): string {
  const text = JSON.stringify({ modelId: assembled.latestModel.id, modeId: assembled.input.modeId,
    text: assembled.text, params: assembled.input.params, refs: assembled.input.refs });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Invalid or retired selections cannot submit and therefore have no current request hash. */
export function currentAudioInputHash(id: string): string | null {
  try { return audioInputHash(assembleAudioRequest(id)); }
  catch (error) { if (error instanceof GenerationInputError) return null; throw error; }
}

export async function executeAudioRequest(id: string, assembled: AudioRequestAssembly, resultNodeIds: string[], jobIds: string[], agentTurnId?: string) {
  await executeChannelAudioRequest(id, assembled, resultNodeIds, jobIds, agentTurnId);
  generationCanvasMutations(agentTurnId).updateNodeData(id, { modelId: assembled.latestModel.id, audioGenerationParams: assembled.latestGenerationParams,
    resultNodeId: resultNodeIds[0], lastRunInputHash: audioInputHash(assembled), lastError: null });
}
