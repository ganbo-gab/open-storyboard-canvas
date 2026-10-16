import { asRecord, cloneWorkflow, nonemptyString, type ComfyUIInputBinding } from './workflow';

export type ComfyUIParameter = 'prompt' | 'negativePrompt' | 'seed' | 'width' | 'height' | 'duration' | 'output' | `image${number}`;
export type ComfyUIBindings = Partial<Record<ComfyUIParameter, ComfyUIInputBinding | null>>;
export interface ComfyUIBindingCandidate extends ComfyUIInputBinding {
  title: string;
  classType: string;
  marked: boolean;
}
export interface ComfyUIBindingDetection {
  candidates: ComfyUIBindingCandidate[];
  status: 'auto' | 'ambiguous' | 'missing';
  binding?: ComfyUIInputBinding;
}

const INPUT_NAMES: Record<string, string[]> = {
  prompt: ['prompt', 'text', 'positive_prompt'], negativePrompt: ['negative_prompt', 'negative', 'text'],
  seed: ['seed', 'noise_seed'], width: ['width'], height: ['height'], duration: ['duration', 'seconds', 'length', 'num_frames'],
};

/** Keep every candidate visible. Title markers resolve selection, never hide alternatives. */
export function detectComfyUIBindings(workflowInput: unknown, imageSlots = 1): Record<ComfyUIParameter, ComfyUIBindingDetection> {
  const workflow = cloneWorkflow(workflowInput);
  const imageCount = Object.values(workflow).filter((node) => /LoadImage/i.test(nonemptyString(node.class_type))).length;
  const parameters: ComfyUIParameter[] = ['prompt', 'negativePrompt', 'seed', 'width', 'height', 'duration', 'output'];
  for (let index = 1; index <= Math.max(imageCount, imageSlots); index++) parameters.push(`image${index}`);
  const detections = {} as Record<ComfyUIParameter, ComfyUIBindingDetection>;
  for (const parameter of parameters) {
    const candidates: ComfyUIBindingCandidate[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      const classType = nonemptyString(node.class_type);
      const title = nonemptyString(asRecord(node._meta)?.title ?? node.title);
      const markers = Array.from(title.matchAll(/(?:OSC|ARCREEL):([a-z][a-z0-9]*)\b/gi), (match) => match[1].toLowerCase());
      const marked = markers.includes(parameter.toLowerCase());
      const image = parameter.startsWith('image');
      const names = parameter === 'output' ? ['$output'] : image ? ['image'] : INPUT_NAMES[parameter] ?? [];
      const inputs = asRecord(node.inputs) ?? {};
      for (const input of names) {
        if (parameter === 'output') {
          if (!marked && !/(?:SaveImage|SaveVideo|SaveAnimated|VideoCombine|VHS_|SaveAudio|PreviewImage)/i.test(classType)) continue;
        } else {
          if (!Object.prototype.hasOwnProperty.call(inputs, input) || Array.isArray(inputs[input])) continue;
          if (!marked && image && !/LoadImage/i.test(classType)) continue;
          if (!marked && ['prompt', 'negativePrompt'].includes(parameter) && input === 'text' && !/CLIPTextEncode|TextEncode/i.test(classType)) continue;
          // Explicit markers on text nodes must not accidentally auto-bind the opposite prompt.
          if (!marked && ['prompt', 'negativePrompt'].includes(parameter) && markers.some((marker) => marker === 'prompt' || marker === 'negativeprompt')) continue;
        }
        candidates.push({ nodeId, input, classType, title: title || classType, marked });
      }
    }
    const preferred = candidates.filter((candidate) => candidate.marked);
    const selection = preferred.length ? preferred : candidates;
    const single = selection.length === 1 ? selection[0] : undefined;
    detections[parameter] = {
      candidates, status: single ? 'auto' : selection.length ? 'ambiguous' : 'missing',
      ...(single ? { binding: { nodeId: single.nodeId, input: single.input } } : {}),
    };
  }
  return detections;
}
