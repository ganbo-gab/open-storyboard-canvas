import { expect, it } from 'vitest';
import { projectGenerationDetails, projectHistoryDiagnostics, redactGenerationDetails } from './generationDetails';
import type { GenerationHistoryRecord } from '../history/history';

const record: GenerationHistoryRecord = { id: 'attempt-old', createdAt: 1, surface: 'canvas', nodeId: 'node', modelRef: 'old-model', prompt: 'saved draft',
  params: { request: { model: 'actual-model', size: '2K', aspectRatio: '16:9', extraParams: { seed: 123 } }, count: 2 }, references: [], status: 'succeeded', outputs: [], jobIds: ['old-job'] };

it('uses recorded parameters and does not claim an old draft is the upstream prompt', () => {
  const result = projectGenerationDetails({ record, jobs: [], target: { nodeId: 'node' }, currentNodeName: 'Renamed now', currentJobId: 'new-job' });
  expect(result.facts.find((fact) => fact.key === 'model')?.value).toBe('actual-model');
  expect(result.facts.find((fact) => fact.key === 'size')?.value).toBe('2K');
  expect(result.facts.find((fact) => fact.key === 'currentTask')?.value).toBe('new-job');
  expect(result.facts.find((fact) => fact.key === 'node')?.value).toBe('node');
  expect(result.upstreamPrompt).toBeUndefined();
  expect(result.prompt).toBe('saved draft');
});

it('only displays exact upstream text when the submission explicitly recorded it', () => {
  const result = projectGenerationDetails({ record: { ...record, upstreamPrompt: 'compiled exact prompt' }, jobs: [], target: { recordId: record.id } });
  expect(result.upstreamPrompt).toBe('compiled exact prompt');
});

it('exposes every retained native batch result without using opaque IndexedDB keys as media URLs', () => {
  const result = projectGenerationDetails({ target: { jobId: 'old-job' }, jobs: [{ job_id: 'old-job', status: 'succeeded', media_type: 'image', result: '/retained/one.png',
    poll_descriptor: { version: 2, adapter: 'comfyui', assets: ['/retained/one.png', '/retained/two.png'], outputs: [{ kind: 'image', url: 'https://fixture/1' }, { kind: 'image', url: 'https://fixture/2' }] } }] });
  expect(result.outputs.map((output) => output.source)).toEqual(['/retained/one.png', '/retained/two.png']);
  const browser = projectGenerationDetails({ target: {}, jobs: [{ job_id: 'web-job', status: 'succeeded',
    poll_descriptor: { version: 2, adapter: 'comfyui', assets: ['web-job:0'] } }] });
  expect(browser.outputs).toEqual([]);
});

it('redacts credential headers, signed URLs and local paths from copyable diagnostics', () => {
  const raw = redactGenerationDetails({ Authorization: 'Bearer private-secret', apiKey: 'private-key', message: 'failed https://example.test/file?token=private-query', path: '/Users/alice/secret.png' });
  expect(raw).not.toContain('private-secret'); expect(raw).not.toContain('private-key'); expect(raw).not.toContain('private-query'); expect(raw).not.toContain('/Users/alice');
});

it('projects browser history into readable log entries without making them recoverable by guessing', () => {
  const entries = projectHistoryDiagnostics([{ ...record, status: 'unknown', error: 'Bearer long-private-value' }]);
  expect(entries[0]).toMatchObject({ source: 'generation', severity: 'error', jobId: 'old-job', recoverable: false });
  expect(entries[0].message).not.toContain('long-private-value');
});

it('uses materialized history results without counting alternate job URLs again', () => {
  const outputs = [{ kind: 'image' as const, source: 'asset-media:first' }, { kind: 'image' as const, source: 'asset-media:second' }];
  const result = projectGenerationDetails({ record: { ...record, outputs }, target: {}, jobs: [{ job_id: 'old-job', status: 'succeeded', results: [
    { kind: 'image', source: 'https://upstream/first.png' }, { kind: 'image', source: 'https://upstream/second.png' },
  ] }] });
  expect(result.outputs).toEqual(outputs);
  expect(result.facts.find((fact) => fact.key === 'results')?.value).toBe(2);
});

it('shows saved native-channel ratio and resolution aliases from the historical input', () => {
  const result = projectGenerationDetails({ record: { ...record, surface: 'workbench', params: { config: { extraParams: { ratio: '9:16', resolutionType: '4K', duration: 8 } } } }, jobs: [], target: {} });
  expect(result.facts.find((fact) => fact.key === 'ratio')?.value).toBe('9:16');
  expect(result.facts.find((fact) => fact.key === 'size')?.value).toBe('4K');
  expect(result.facts.find((fact) => fact.key === 'duration')?.value).toBe(8);
});

it('counts saved explicit slots without double-counting legacy media refs or reading the current draft', () => {
  const result = projectGenerationDetails({ record: { ...record, surface: 'workbench', params: { referenceSlots: { first: ['/saved-one.png'], last: ['/saved-two.png'] } }, references: [{ id: 'old-image', kind: 'image', source: '/saved-one.png' }, { id: 'text', kind: 'text', source: 'saved context' }] }, jobs: [], target: {} });
  expect(result.facts.find((fact) => fact.key === 'references')?.value).toBe(3);
});
it('labels a later conversation association separately from the submission project', () => {
  const currentOnly = projectGenerationDetails({ record: { ...record, conversationId: 'conversation', projectId: 'current', projectAttribution: 'current-conversation', currentProjectId: 'current' }, projectName: 'Current project', currentProjectName: 'Current project', jobs: [], target: {} });
  expect(currentOnly.facts.find((fact) => fact.key === 'project')?.value).toBeUndefined();
  expect(currentOnly.facts.find((fact) => fact.key === 'currentProject')?.value).toBe('Current project');
  const retained = projectGenerationDetails({ record: { ...record, conversationId: 'conversation', projectId: 'submitted', projectAttribution: 'submission', currentProjectId: 'current' }, projectName: 'Submitted project', currentProjectName: 'Current project', jobs: [], target: {} });
  expect(retained.facts.find((fact) => fact.key === 'project')?.value).toBe('Submitted project');
  expect(retained.facts.find((fact) => fact.key === 'currentProject')?.value).toBe('Current project');
});

it('projects the frozen selected model instead of obsolete node fields in technical diagnostics', () => {
  const saved: GenerationHistoryRecord = { ...record, params: { nodeType: 'imageNode', nodeData: {
    imageUrl: null, prompt: 'Captured prompt',
    model: 'kie/nano-banana-2', modelId: 'stale-alias', size: '2K', aspectRatio: '1:1',
    modelConfig: { entryId: 'custom:fixture:gpt-image-2.6', ratio: 'auto', extraParams: { size: '1024x576', n: 1, quality: 'high', apiKey: 'PRIVATE_FIXTURE' } },
  }, request: { model: 'submitted-model', size: '', aspectRatio: '', extraParams: { size: '1024x576', quality: 'high' } } } };
  const before = structuredClone(saved);
  const details = projectGenerationDetails({ record: saved, jobs: [], target: {}, currentJobId: 'later-job' });
  expect(details.facts).toEqual(expect.arrayContaining([
    { key: 'model', value: 'submitted-model' }, { key: 'size', value: '1024x576' }, { key: 'ratio', value: '16:9' },
  ]));
  expect(JSON.parse(details.diagnostics)).toMatchObject({ record: { params: { node: {
    generationConfiguration: { source: 'modelConfig', meaning: 'configuration-at-capture', model: 'custom:fixture:gpt-image-2.6', size: '1024x576', aspectRatio: '16:9' },
  } } } });
  expect(JSON.parse(details.diagnostics)).not.toHaveProperty('record.params.node.displayAspectRatio');
  for (const stale of ['kie/nano-banana-2', 'stale-alias', 'PRIVATE_FIXTURE']) expect(details.diagnostics).not.toContain(stale);
  expect(saved).toEqual(before);
});

it('uses persisted job evidence before captured configuration and never rewrites old attempts', () => {
  const historical: GenerationHistoryRecord = { ...record, modelRef: 'incorrect-legacy-label', params: { nodeData: {
    imageUrl: null, prompt: 'Captured prompt',
    model: 'legacy-default', size: '2K', aspectRatio: '1:1', modelConfig: { entryId: 'selected-at-capture', ratio: '9:16', extraParams: { size: '576x1024' } },
  } } };
  const before = structuredClone(historical);
  const result = projectGenerationDetails({ record: historical, target: {}, currentJobId: 'new-job', jobs: [{
    job_id: 'old-job', status: 'succeeded', model_id: 'job-model', poll_descriptor: { version: 2, adapter: 'template', input: { modelId: 'submitted-job-model', params: { size: '1536x1024' } } },
  }] });
  expect(result.facts).toEqual(expect.arrayContaining([{ key: 'model', value: 'submitted-job-model' }, { key: 'size', value: '1536x1024' }, { key: 'ratio', value: '3:2' }]));
  expect(historical).toEqual(before);
  const legacy = projectGenerationDetails({ record: { ...record, params: { nodeData: { imageUrl: null, prompt: 'Legacy prompt', model: 'legacy-model', size: '4K', requestAspectRatio: '9:16', aspectRatio: '1:1' } } }, jobs: [], target: {} });
  expect(legacy.facts).toEqual(expect.arrayContaining([{ key: 'size', value: '4K' }, { key: 'ratio', value: '9:16' }]));
});
