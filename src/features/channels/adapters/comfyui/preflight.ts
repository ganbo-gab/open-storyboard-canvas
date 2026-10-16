import { asRecord, cloneWorkflow, nonemptyString } from './workflow';

export interface ComfyUIPreflightResult {
  ok: boolean;
  missingNodeClasses: { nodeId: string; classType: string }[];
  missingModelFiles: { nodeId: string; classType: string; input: string; filename: string; available: string[] }[];
}

/** Only check enumerated loader model fields; arbitrary strings are not filenames. */
export function preflightComfyUIWorkflow(objectInfo: unknown, workflowInput: unknown): ComfyUIPreflightResult {
  const workflow = cloneWorkflow(workflowInput);
  const info = asRecord(objectInfo);
  if (!info) throw new Error('ComfyUI object_info 响应无效。');
  const result: ComfyUIPreflightResult = { ok: true, missingNodeClasses: [], missingModelFiles: [] };
  for (const [nodeId, node] of Object.entries(workflow)) {
    const classType = nonemptyString(node.class_type);
    const definition = Object.prototype.hasOwnProperty.call(info, classType) ? asRecord(info[classType]) : null;
    if (!definition) {
      result.missingNodeClasses.push({ nodeId, classType });
      continue;
    }
    if (!/load|checkpoint|lora/i.test(classType)) continue;
    const schema = asRecord(definition.input);
    const fields = { ...asRecord(schema?.required), ...asRecord(schema?.optional) };
    for (const [input, value] of Object.entries(asRecord(node.inputs) ?? {})) {
      if (typeof value !== 'string' || !/(?:ckpt|checkpoint|model|lora|vae|clip|unet|control_net|diffusion|file).*name|^(?:checkpoint|model|lora|vae|clip|unet|control_net)$/i.test(input)) continue;
      const field = fields[input];
      const options = Array.isArray(field) ? field[0] : null;
      if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) continue;
      if (!options.includes(value)) result.missingModelFiles.push({ nodeId, classType, input, filename: value, available: options });
    }
  }
  result.ok = result.missingNodeClasses.length === 0 && result.missingModelFiles.length === 0;
  return result;
}
