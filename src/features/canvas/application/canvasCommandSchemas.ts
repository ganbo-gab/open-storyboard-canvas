import type { CanvasCommandType, CanvasJsonSchema } from '../domain/canvasCommands';
import { CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES } from '../domain/canvasCapabilities';
import { TAG_COLORS, TAG_GROUP_SHAPES } from '../domain/canvasNodes';
import type { MediaEditOperation } from './media';

function objectSchema(
  required: string[],
  properties: Record<string, CanvasJsonSchema['properties'][string]>,
): CanvasJsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

const stringField = (description: string, values?: readonly string[]) => ({
  type: 'string' as const,
  description,
  ...(values ? { enum: values } : {}),
});
const numberField = (description: string) => ({ type: 'number' as const, description });
const booleanField = (description: string) => ({ type: 'boolean' as const, description });
const arrayField = (description: string, items?: CanvasJsonSchema['properties'][string]) => ({
  type: 'array' as const,
  description,
  ...(items ? { items } : {}),
});
const objectField = (
  description: string,
  properties?: Record<string, CanvasJsonSchema['properties'][string]>,
  required?: string[],
  additionalProperties?: boolean,
) => ({
  type: 'object' as const,
  description,
  ...(properties ? { properties } : {}),
  ...(required ? { required } : {}),
  ...(additionalProperties !== undefined ? { additionalProperties } : {}),
});

const finitePositionField = objectField('Finite canvas position hint; the application may move it to nearby empty space.', {
  x: numberField('Finite canvas X coordinate.'),
  y: numberField('Finite canvas Y coordinate.'),
}, ['x', 'y'], false);

const createConfigurationField = objectField('Allowed create-time configuration. Use aspectRatio (not ratio) and resolution (not size).', {
  displayName: stringField('Optional visible node title.'),
  imageUrl: stringField('Durable image/upload node source: asset-media image reference, absolute persisted path, app asset URL, or HTTP(S). No blob/data/file/executable URLs.'),
  prompt: stringField('Generation prompt.'),
  content: stringField('Text annotation content.'),
  modelId: stringField('Exact configured catalog model id.'),
  providerId: stringField('Optional configured text provider id.'),
  aspectRatio: stringField('Requested ratio such as 16:9.'),
  resolution: stringField('Requested resolution such as 2K.'),
  duration: stringField('Requested video duration.'),
  extraParams: objectField('Bounded model-specific parameters.', undefined, undefined, true),
  modeId: stringField('Declared channel ModeSpec.id; omitted selects the default mode.'),
  referenceSlots: objectField('Declared slot key → ordered media source strings, in the same URL/path/asset-media/data URL form as reference images. Slot kind/min/max are validated before submission; no role guessing.', undefined, undefined, true),
  openDirectorStudio: booleanField('Open Director Studio after creation.'),
  directorStudioMode: stringField('Director Studio mode.', ['flat', 'panorama']),
  directorStudioWorkspace: stringField('Workspace to open with openDirectorStudio: director (scene layout) or previs (timeline, routes, playback).', ['director', 'previs']),
  enabled: booleanField('Whether a tag or tag group is enabled.'),
  tagColor: stringField('Legacy tag color.', TAG_COLORS),
  memberNodeIds: arrayField('Direct tag-group member node ids.', stringField('Canvas node id.')),
  tagGroupColor: stringField('Tag-group color.', TAG_COLORS),
  tagGroupShape: stringField('Tag-group shape.', TAG_GROUP_SHAPES),
}, [], false);

const mediaOperationVariant = (
  kind: MediaEditOperation['kind'],
  fields: Record<string, CanvasJsonSchema['properties'][string]>,
  required: string[],
): CanvasJsonSchema['properties'][string] => objectField(
  kind, { kind: stringField('Local operation kind.', [kind]), ...fields }, ['kind', ...required], false,
);
const nonnegativeSeconds = { ...numberField('Finite source time in seconds.'), minimum: 0 };
const mediaOperationField: CanvasJsonSchema['properties'][string] = {
  type: 'object',
  description: 'Local, generation-free media edit. Creates durable connected result nodes without replacing source media.',
  oneOf: [
    mediaOperationVariant('image.transform', {
      rotate: { ...numberField('Clockwise rotation in degrees.'), enum: [0, 90, 180, 270] },
      flipX: booleanField('Flip horizontally.'), flipY: booleanField('Flip vertically.'),
    }, ['rotate']),
    mediaOperationVariant('video.captureFrame', { timeSeconds: nonnegativeSeconds }, ['timeSeconds']),
    mediaOperationVariant('video.trim', { startSeconds: nonnegativeSeconds, endSeconds: nonnegativeSeconds }, ['startSeconds', 'endSeconds']),
    mediaOperationVariant('video.crop', { rect: objectField('Normalized crop bounds; x + width and y + height cannot exceed one.', {
      x: { ...numberField('Left fraction.'), minimum: 0, maximum: 1 },
      y: { ...numberField('Top fraction.'), minimum: 0, maximum: 1 },
      width: { ...numberField('Positive width fraction.'), minimum: 0, maximum: 1 },
      height: { ...numberField('Positive height fraction.'), minimum: 0, maximum: 1 },
    }, ['x', 'y', 'width', 'height'], false) }, ['rect']),
    mediaOperationVariant('video.separateAudio', {}, []),
    mediaOperationVariant('audio.slice', { startSeconds: nonnegativeSeconds, endSeconds: nonnegativeSeconds }, ['startSeconds', 'endSeconds']),
    mediaOperationVariant('audio.split', { atSeconds: { ...arrayField('Strictly ascending positive split times.', nonnegativeSeconds), minItems: 1 } }, ['atSeconds']),
    mediaOperationVariant('audio.rate', { rate: { ...numberField('Playback rate; changes pitch.'), minimum: 0.5, maximum: 2 } }, ['rate']),
  ],
};

export const CANVAS_COMMAND_INPUT_SCHEMAS: Record<CanvasCommandType, CanvasJsonSchema> = {
  'canvas.query': objectSchema(['scope'], {
    scope: stringField('Bounded projection to return.', ['graph', 'nodes', 'edges', 'selection']),
    nodeIds: arrayField('Optional node id filter.'),
    limit: numberField('Maximum number of records.'),
  }),
  'node.create': objectSchema(['nodeType', 'position'], {
    nodeType: stringField(
      'Exact registered directly creatable canvas node type. For image generation use imageNode.',
      CANVAS_AGENT_DIRECT_CREATE_NODE_TYPES,
    ),
    position: finitePositionField,
    nodeId: stringField('Optional caller-provided stable node id.'),
    dimensions: objectField('Optional finite positive initial dimensions.', {
      width: numberField('Positive width.'),
      height: numberField('Positive height.'),
    }, ['width', 'height'], false),
    configuration: createConfigurationField,
  }),
  'node.delete': objectSchema(['nodeIds'], { nodeIds: arrayField('Node ids to delete with descendants.') }),
  'node.rename': objectSchema(['nodeId', 'displayName'], {
    nodeId: stringField('Node id.'),
    displayName: stringField('New display name.'),
  }),
  'node.setPrompt': objectSchema(['nodeId', 'prompt'], {
    nodeId: stringField('Prompt-capable node id.'),
    prompt: stringField('New prompt or annotation content.'),
  }),
  'node.setModelConfig': objectSchema(['nodeId', 'modelId'], {
    nodeId: stringField('Generation node id.'),
    modelId: stringField('Catalog model id.'),
    providerId: stringField('Optional provider id.'),
    aspectRatio: stringField('Optional request ratio.'),
    resolution: stringField('Optional video resolution.'),
    duration: stringField('Optional video duration.'),
    extraParams: objectField('Model-specific validated parameter values.'),
    modeId: stringField('Declared channel ModeSpec.id; omitted preserves the selected mode.'),
    referenceSlots: objectField('Declared slot key → ordered media source strings, in the same URL/path/asset-media/data URL form as reference images. Replaces generic references; slot kind/min/max are validated before submission.', undefined, undefined, true),
  }),
  'node.move': objectSchema(['positions'], { positions: arrayField('Node id and finite position records.') }),
  'node.layout': objectSchema(['nodeIds', 'direction'], {
    nodeIds: arrayField('Node ids to lay out.'),
    direction: stringField('horizontal, vertical, or grid.'),
    origin: objectField('Optional canvas origin.'),
    gap: numberField('Optional non-negative gap.'),
    columns: numberField('Optional positive grid column count.'),
  }),
  'node.setEnabled': objectSchema(['nodeIds', 'enabled'], {
    nodeIds: arrayField('Canvas node ids to update atomically.'),
    enabled: booleanField('Whether these nodes may run generation/tools or contribute enabled tag references.'),
  }),
  'node.duplicate': objectSchema(['copies'], {
    copies: arrayField('Node copy records. Copies preserve configuration and inherit all graph connections; internal endpoints are remapped to their copies.'),
  }),
  'batch.setPrimary': objectSchema(['batchId', 'nodeId'], {
    batchId: stringField('Sibling generation result batch id.'), nodeId: stringField('Member node to promote to primary.'),
  }),
  'batch.setCollapsed': objectSchema(['batchId', 'collapsed'], {
    batchId: stringField('Sibling generation result batch id.'), collapsed: booleanField('Hide secondary members without removing graph nodes or edges.'),
  }),
  'batch.split': objectSchema(['batchId'], {
    batchId: stringField('Existing result stack to separate into independent visible nodes; preserves media and graph edges.'),
  }),
  'node.media.edit': objectSchema(['nodeId', 'operation'], {
    nodeId: stringField('Existing image, video or audio source node id.'), operation: mediaOperationField,
  }),
  'node.tool.run': objectSchema(['nodeId', 'toolType'], {
    nodeId: stringField('Image source node id.'),
    toolType: stringField('Registered image or storyboard tool type.'),
    options: objectField('Bounded tool-specific options.'),
  }),
  'storyboard.update': objectSchema(['nodeId'], {
    nodeId: stringField('Storyboard split node id.'),
    frames: arrayField('Frame note/order patches.'),
    exportOptions: objectField('Storyboard export display options.'),
  }),
  'storyboard.merge': objectSchema(['nodeIds'], {
    nodeIds: { ...arrayField('Image node ids in exact frame order. Sources and their graph connections remain unchanged.', stringField('Image node id.')), minItems: 2 },
    nodeId: stringField('Optional stable id for the new storyboard split node.'),
    displayName: stringField('Optional storyboard display name.'),
    columns: { ...numberField('Optional positive integer grid column count, at most the number of frames.'), minimum: 1 },
  }),
  'panorama.update': objectSchema(['nodeId'], {
    nodeId: stringField('Panorama node id.'),
    sourceMode: stringField('text or image.'),
    sourceAssetId: stringField('Stable source image asset id.'),
    sourcePrompt: stringField('Panorama generation prompt.'),
    projection: stringField('spherical or cylindrical.'),
    smartBase: booleanField('Use the panorama base-image constraint.'),
    initialYaw: numberField('Initial viewer yaw.'),
    initialPitch: numberField('Initial viewer pitch.'),
    initialFov: numberField('Initial viewer field of view.'),
  }),
  'director.update': objectSchema(['nodeId'], {
    nodeId: stringField('Director Studio node id.'),
    mode: stringField('flat or panorama.'),
    basePrompt: stringField('Scene prompt.'),
    aspectRatio: stringField('Canvas aspect ratio.'),
    aspectFrame: stringField('Director aspect frame.'),
    screenshotResolution: stringField('Screenshot resolution.'),
    themeColor: stringField('Director Studio theme color.'),
    backgroundAssetId: stringField('Stable background image asset id.'),
    backgroundPanoramaAssetId: stringField('Stable panorama background asset id.'),
    referenceAssetIds: arrayField('Stable reference asset ids.'),
    items: arrayField('Structured Director Studio scene items.'),
    customActionPresets: arrayField('Custom action names.'),
    customActionPoses: objectField('Custom action poses.'),
    camera: objectField('Camera settings.'),
    lighting: objectField('Lighting settings.'),
    grid: objectField('Grid settings.'),
    viewSettings: objectField('View settings.'),
    shortcuts: objectField('Shortcut bindings.'),
    motionProject: objectField('Versioned Director Studio motion project, or null.'),
  }),
  'director.open': objectSchema(['nodeId'], {
    nodeId: stringField('Director Studio node id.'),
    focus: booleanField('Focus the owning canvas node before opening.'),
  }),
  'director.record': objectSchema(['nodeId', 'resolution', 'fps'], {
    nodeId: stringField('Director Studio node id.'),
    resolution: stringField('720p or 1080p.'),
    fps: numberField('24 or 30 frames per second.'),
    addToCanvas: booleanField('Create and locate a canvas video node after recording.'),
  }),
  'tag.setColor': objectSchema(['tagId', 'color'], {
    tagId: stringField('Tag node id.'),
    color: stringField('Registered semantic tag color.'),
  }),
  'tagGroup.setMembers': objectSchema(['groupId', 'memberNodeIds'], {
    groupId: stringField('Tag-group node id.'),
    memberNodeIds: arrayField('Explicit direct image, video, and text member node ids.'),
  }),
  'tagGroup.setAppearance': objectSchema(['groupId'], {
    groupId: stringField('Tag-group node id.'),
    color: stringField('Registered semantic group color.'),
    shape: stringField('rectangle, rounded, or frame.'),
  }),
  'edge.connect': objectSchema(['sourceNodeId', 'targetNodeId'], {
    sourceNodeId: stringField('Source node id.'),
    targetNodeId: stringField('Target node id.'),
    edgeId: stringField('Optional caller-provided stable edge id.'),
  }),
  'edge.disconnect': objectSchema(['edgeIds'], { edgeIds: arrayField('Edge ids to delete.') }),
  'selection.connect': objectSchema(['sourceNodeIds', 'targetNodeId'], {
    sourceNodeIds: { ...arrayField('Explicit source node ids to connect atomically; existing exact connections are reused.', stringField('Source node id.')), minItems: 1 },
    targetNodeId: stringField('One reference-compatible target node id.'),
  }),
  'group.create': objectSchema(['nodeIds'], {
    nodeIds: arrayField('Member node ids.'),
    groupId: stringField('Optional caller-provided stable group id.'),
    displayName: stringField('Optional group display name.'),
  }),
  'group.ungroup': objectSchema(['groupIds'], { groupIds: arrayField('Group ids to dissolve.') }),
  'selection.set': objectSchema(['nodeIds'], { nodeIds: arrayField('Node ids to select, or empty to clear.') }),
  'viewport.focus': objectSchema(['nodeIds'], {
    nodeIds: arrayField('Node ids to focus.'),
    padding: numberField('Viewport padding from zero to one.'),
    select: booleanField('Whether to select focused nodes.'),
  }),
  'asset.list': objectSchema([], {
    kind: stringField('Optional image, video, or audio filter.'),
    query: stringField('Optional case-insensitive title, source, or asset id search.'),
    nodeIds: arrayField('Optional exact owning node ids.'),
    relatedToNodeIds: arrayField('Optional node ids whose direct graph neighbors should be searched.'),
    selectedOnly: booleanField('Only return assets owned by selected nodes.'),
    region: objectField('Optional finite canvas rectangle with x, y, width, and height.'),
    limit: numberField('Maximum number of assets.'),
  }),
  'asset.locate': objectSchema(['assetId'], {
    assetId: stringField('Stable asset id from asset.list.'),
    select: booleanField('Whether to select the asset node.'),
  }),
  'generation.submit': objectSchema(['nodeIds'], { nodeIds: arrayField('Generation-capable node ids.') }),
  'generation.recover': objectSchema(['jobId'], {
    jobId: stringField('Persisted generation job id with a safe upstream handle.'),
    nodeIds: arrayField('Optional canvas nodes already associated with this job.'),
  }),
  'generation.status': objectSchema([], {
    nodeId: stringField('Generation node id.'),
    jobId: stringField('Stable generation job id.'),
  }),
  'generation.locateResult': objectSchema([], {
    nodeId: stringField('Generation node id.'),
    jobId: stringField('Stable generation job id.'),
    select: booleanField('Whether to select the result node.'),
  }),
};
