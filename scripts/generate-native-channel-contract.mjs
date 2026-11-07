import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { channelProfileSchema } from '../src/features/channels/domain/profile.ts';
import { applyModelCapabilityPreset } from '../src/features/channels/application/modelCapabilityPresets.ts';
import { openAIStandardProfile } from '../src/features/channels/presets/openai.ts';

// Node 24 strips TS types. Imports execute the real frontend schema/preset code;
// this script never imports stores, reads credentials, or sends network requests.
const source = new URL('../src/features/channels/domain/profile.ts', import.meta.url);
const destination = new URL('../src-tauri/src/commands/fixtures/channel-snapshot-contract.json', import.meta.url);
const snapshot = (id, profile, modelId, operation, modeId) => ({
  version: 2, adapter: 'template', profile: channelProfileSchema.parse(profile),
  input: { jobId: id, channelId: profile.id, modelId, ...(modeId ? { modeId } : {}), operation, prompt: '', params: {}, refs: [], count: 1 }, submit: {},
});
const chat = structuredClone(openAIStandardProfile);
chat.id = 'fixture-known-capabilities';
chat.name = 'Known model contract fixture';
const chatModel = chat.models.find((model) => model.operations.includes('chat'));
if (!chatModel) throw new Error('Real chat preset missing');
chatModel.id = 'deepseek-v4.1-flash';
chat.models = [applyModelCapabilityPreset(chatModel)];
if (!chat.models[0].capabilities) throw new Error('Known model capability preset missing');
const known = snapshot('fixture-known-capabilities-job', chat, chat.models[0].id, 'chat');
const displays = ['auto', 'buttons', 'select', 'slider', 'hidden'];
const params = displays.map((display, i) => ({ key: `quality_${i}`, label: `Quality ${i}`, type: 'enum', display,
  min: 0, max: 1, step: 0.5, required: false, description: 'Fixture parameter', group: 'advanced', default: 1,
  options: [{ label: 'One', value: 1 }] }));
params.push({ key: 'size', label: 'Frame', type: 'enum', sizeDisplay: 'ratio-resolution', default: '1024x1024',
  options: [{ label: 'Square', value: '1024x1024', size: { ratio: '1:1', resolution: '1K' } }, { label: 'Auto', value: 'auto' }] });
params.push({ key: 'pixelSize', label: 'Pixel frame', type: 'enum', sizeDisplay: 'pixels',
  options: [{ label: 'Portrait', value: '1024x1536', size: { ratio: '2:3', resolution: '1536px' } }] });
const endpoint = { method: 'POST', path: '/model/{{mode}}', body: 'multipart', files: { field: 'image', cardinality: 'single' },
  imageEncoding: 'url', errorPath: 'error.message', template: { model: '{{model}}', image: '{{slotFirst.reference}}', quality: '{{param.quality_0}}' },
  response: { mode: 'async', taskIdPath: 'id', poll: { method: 'POST', path: '/jobs/{{taskId}}', template: { id: '{{taskId}}' }, intervalSec: 1,
    timeoutMin: 2, statusPath: 'status', success: ['done'], failure: ['failed'], progressPath: 'progress',
    resultRequest: { method: 'GET', path: '/result/{{poll.file_id}}', template: { original: '{{submit.id}}' } },
    outputs: [{ url: '/models/{{taskId}}/file.glb', kind: 'model', auth: true }, { path: 'preview.url', as: 'url', kind: 'image' }] } } };
const richProfile = { version: 2, id: 'fixture-all-declarations', name: 'All declarations', baseUrl: 'https://fixture.example',
  auth: { type: 'header', name: 'X-Api-Key', prefix: 'Key ' }, headers: { 'X-Client': 'Fixture' }, docsUrl: 'https://fixture.example/docs', notes: ['Schema coverage'],
  operations: {}, models: [{ id: 'model', label: 'Fixture model', operations: ['model.generate'], params, mention: 'natural', refs: { image: 1, video: 0, audio: 0 },
    capabilities: { contextWindow: 1048576, maxOutputTokens: 131072, supportsMultimodal: false, supportsTools: true, supportsStreaming: false },
    modes: [{ id: 'image-to-model', label: 'From image', description: 'Mode declaration', operation: 'model.generate', params,
      slots: [{ key: 'reference', label: 'Reference', kind: 'image', min: 0, max: 1, description: 'Optional fixture' }], endpoint }] }] };
const rich = snapshot('fixture-all-declarations-job', richProfile, 'model', 'model.generate', 'image-to-model');
rich.credentialSource = 'transient';
rich.submit = { id: 'accepted-once' };
rich.outputs = [{ kind: 'model', url: 'https://fixture.example/original.glb', auth: true }, { kind: 'text', text: 'Fixture text output' }];
rich.assets = ['imported-model-fixture', 'Fixture text output']; rich.assetKinds = ['model', 'text'];
rich.failure = { category: 'credential', message: 'Credential access paused', raw: 'Safe fixture diagnostic', status: 401 };
const emptyCapabilities = structuredClone(known);
emptyCapabilities.input.jobId = 'fixture-empty-capabilities-job'; emptyCapabilities.profile.models[0].capabilities = {};
channelProfileSchema.parse(emptyCapabilities.profile);

function replace(root, path, value) {
  const keys = path.split('/').slice(1);
  const parent = keys.slice(0, -1).reduce((current, key) => current[key], root);
  parent[keys.at(-1)] = value;
}
const invalidProfiles = [];
const reject = (path, value) => {
  const candidate = structuredClone(richProfile); replace(candidate, path, value);
  if (channelProfileSchema.safeParse(candidate).success) throw new Error(`Fixture is not rejected by TS: ${path}`);
  invalidProfiles.push({ path: `/profile${path}`, value });
};
for (const field of ['contextWindow', 'maxOutputTokens']) for (const value of [0, -1, 1.5, '1000', null, true, 9007199254740992]) reject(`/models/0/capabilities/${field}`, value);
for (const field of ['supportsMultimodal', 'supportsTools', 'supportsStreaming']) for (const value of ['true', 1, null, {}]) reject(`/models/0/capabilities/${field}`, value);
for (const value of [null, [], 'untyped']) reject('/models/0/capabilities', value);
reject('/models/0/capabilities/invented', true); reject('/models/0/capabilities/apiKey', 'PRIVATE_FIXTURE');
for (const prefix of ['/models/0/params/0', '/models/0/modes/0/params/0']) for (const value of ['range', '', false, null, {}]) reject(`${prefix}/display`, value);
for (const prefix of ['/models/0/params/5', '/models/0/modes/0/params/5']) {
  for (const value of ['range', '', false, null, {}]) reject(`${prefix}/sizeDisplay`, value);
  for (const value of [null, [], '1K', { ratio: '1:1' }, { ratio: 1, resolution: '1K' }, { ratio: '1:1', resolution: '' }]) reject(`${prefix}/options/0/size`, value);
  reject(`${prefix}/options/0/size/invented`, true);
}
for (const path of ['', '/auth', '/models/0', '/models/0/refs', '/models/0/params/0', '/models/0/params/0/options/0',
  '/models/0/modes/0', '/models/0/modes/0/slots/0', '/models/0/modes/0/endpoint', '/models/0/modes/0/endpoint/files',
  '/models/0/modes/0/endpoint/response', '/models/0/modes/0/endpoint/response/poll',
  '/models/0/modes/0/endpoint/response/poll/resultRequest', '/models/0/modes/0/endpoint/response/poll/outputs/0']) reject(`${path}/invented`, true);

const fixture = { formatVersion: 1, generatedBy: 'scripts/generate-native-channel-contract.mjs',
  profileSourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  accepted: [known, rich, emptyCapabilities], rejectedProfileMutations: invalidProfiles };
const content = `${JSON.stringify(fixture, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== content) throw new Error('Native channel fixture is stale; run node scripts/generate-native-channel-contract.mjs');
  console.log(`Native channel fixture is current (${fixture.accepted.length} accepted, ${invalidProfiles.length} rejected cases).`);
} else {
  await mkdir(new URL('.', destination), { recursive: true });
  await writeFile(destination, content);
  console.log(`Wrote ${fileURLToPath(destination)}`);
}
