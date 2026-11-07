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
