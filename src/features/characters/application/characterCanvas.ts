import { resolveAsset, type AssetRecord } from '@/features/assets/application/assetCatalog';
import { CANVAS_COMMAND_VERSION, type CreateNodeCommand } from '@/features/canvas/domain/canvasCommands';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { isDurableCanvasImageSource } from '@/features/canvas/domain/canvasMediaSources';
import type { Character } from '../domain/types';
import { CharacterLibraryError, type CharacterAssetPort } from './characterLibrary';

/** A pure, executable generic command; does not mutate the canvas or persist display URLs. */
export function buildCharacterCanvasCommand(
  character: Character,
  mainAsset: AssetRecord,
  position: { x: number; y: number } = { x: 0, y: 0 },
  nodeId?: string,
): CreateNodeCommand {
  if (!character.mainImage || !character.images.some((image) => image.assetId === character.mainImage?.assetId)) {
    throw new CharacterLibraryError('mainImageRequired', 'Character needs a main image to apply to canvas');
  }
  if (mainAsset.id !== character.mainImage.assetId || mainAsset.kind !== 'image') throw new CharacterLibraryError('imageRequired', 'The main image asset does not match this character');
  if (!isDurableCanvasImageSource(mainAsset.source)) throw new CharacterLibraryError('mediaNotDurable', 'Main image is not a durable canvas image source');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !character.name.trim() || character.name.length > 200 || (nodeId !== undefined && !nodeId.trim())) {
    throw new CharacterLibraryError('invalidInput', 'A finite position, valid name, and non-empty node id are required');
  }
  return { type: 'node.create', version: CANVAS_COMMAND_VERSION, input: {
    nodeType: CANVAS_NODE_TYPES.imageEdit, position: { ...position }, ...(nodeId ? { nodeId } : {}),
    configuration: { displayName: character.name, imageUrl: mainAsset.source },
  } };
}
export async function createCharacterCanvasCommand(
  character: Character,
  position: { x: number; y: number } = { x: 0, y: 0 },
  nodeId?: string,
  assets?: Pick<CharacterAssetPort, 'resolveAsset'>,
): Promise<CreateNodeCommand> {
  if (!character.mainImage) throw new CharacterLibraryError('mainImageRequired', 'Character needs a main image to apply to canvas');
  const port = assets ?? { resolveAsset };
  const asset = await port.resolveAsset(character.mainImage.assetId);
  if (!asset) throw new CharacterLibraryError('assetNotFound', 'Character main image asset was not found');
  return buildCharacterCanvasCommand(character, asset, position, nodeId);
}
