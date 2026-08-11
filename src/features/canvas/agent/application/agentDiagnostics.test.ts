import { beforeEach, describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { scanForSensitiveOutput } from './agentRedaction';
import {
  buildDiagnosticBundlePreview,
  classifyAgentError,
  diagnosticBundleFileName,
  extractSafeDiagnosticBundlePreview,
  formatDiagnosticIssueDraft,
  inspectCanvasHealth,
  inspectDiagnosticConfigSnapshot,
  inspectRedactedApplicationConfig,
  inspectRedactedProviderConfig,
  preflightGeneration,
  projectSafeGenerationJobDiagnostic,
  serializeSafeDiagnosticBundlePreview,
} from './agentDiagnostics';

function canvasNode(input: Partial<CanvasNode> & Pick<CanvasNode, 'id' | 'type' | 'data'>): CanvasNode {
  return {
    position: { x: 0, y: 0 },
    ...input,
  } as CanvasNode;
}

describe('agent diagnostics', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
    useCustomProvidersStore.setState({ providers: [] });
  });

  it('classifies issue 11 as a generic pixel-limit contradiction with three distinct remedies', () => {
    const report = classifyAgentError({
      statusCode: 400,
      code: 'invalid_size',
      message: '4K 3:4 request has 12,582,912 pixels > 8,294,400 limit',
    });
    expect(report.classification).toEqual(['input', 'configuration']);
    expect(report.userWorkaround).toContain('降低分辨率');
    expect(report.configFix).toMatchObject({ kind: 'provider', patch: { constraint: 'maxPixels' } });
    expect(report.softwareFix).toContain('所有比例和档位');
  });

  it.each([
    ['missing auth', { code: 'missing_api_key', message: 'Missing API key' }, 'configuration', 'auth-missing'],
    ['invalid endpoint', { code: 'invalid_endpoint', message: 'endpoint invalid' }, 'configuration', 'endpoint-invalid'],
    ['vision capability', { capability: 'vision', message: 'model does not support vision' }, 'configuration', 'capability-vision-unsupported'],
    ['tools capability', { capability: 'tools', message: 'model does not support tools' }, 'configuration', 'capability-tools-unsupported'],
    ['rate limit', { status: 429, message: 'Too many requests' }, 'upstream', 'upstream-rate-limit'],
    ['server fault', { status: 503, message: 'Service unavailable' }, 'upstream', 'upstream-server-error'],
    ['proxy failure', { message: 'proxy tunnel failed' }, 'network', 'network-proxy-failure'],
    ['dns failure', { message: 'DNS resolve failed' }, 'network', 'network-dns-failure'],
    ['tls failure', { message: 'TLS certificate invalid' }, 'network', 'network-tls-failure'],
    ['timeout', { code: 'ETIMEDOUT', message: 'Request timed out' }, 'network', 'network-timeout-unknown-result'],
    ['malformed response', { phase: 'response', message: 'Unexpected token < in JSON' }, 'upstream', 'provider-response-malformed'],
  ])('deterministically classifies %s', (_name, error, expectedClass, expectedCode) => {
    const result = classifyAgentError(error);
    expect(result.classification).toContain(expectedClass);
    expect(result.evidence[0]).toMatchObject({ code: expectedCode });
  });

  it('blocks the issue 11 explicit size before any paid request', () => {
    const report = preflightGeneration({ width: 3072, height: 4096, aspectRatio: '3:4', maxPixels: 8_294_400 });
    expect(report.summary).toContain('阻断');
    expect(report.evidence[0]).toMatchObject({ code: 'pixel-limit', severity: 'blocking' });
    expect(report.evidence[0].message).toContain('12,582,912');
  });

  it('projects persistent generation jobs without leaking result URLs or poll descriptors', () => {
    const projected = projectSafeGenerationJobDiagnostic({
      job_id: 'job-1',
      status: 'recoverable_wait',
      media_type: 'image',
      provider_id: 'provider-1',
      model_id: 'model-1',
      phase: 'polling',
      external_task_id: 'task-123',
      result_url: 'https://cdn.example/result.png?signature=secret-signature',
      poll_descriptor: {
        authorization: 'Bearer private-token',
        pathTemplate: '/tasks/{taskId}',
      },
      error_category: 'timeout',
      network_route: 'custom-proxy',
      submit_attempts: 1,
      consecutive_network_errors: 3,
    });

    expect(projected).toMatchObject({
      jobId: 'job-1',
      status: 'recoverable_wait',
      externalTaskId: 'task-123',
      hasResultUrl: true,
      safeRecoveryAvailable: true,
      automaticResubmitAllowed: false,
      submitAttempts: 1,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('secret-signature');
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('pathTemplate');
  });

  it('reports missing media, invalid params, duplicate ids, dangling edges, and stalled jobs with locations', () => {
    const now = 10_000_000;
    useCanvasStore.setState({
      nodes: [
        canvasNode({ id: 'duplicate-node', type: CANVAS_NODE_TYPES.upload, data: { imageUrl: null, aspectRatio: 'broken' } }),
        canvasNode({ id: 'duplicate-node', type: CANVAS_NODE_TYPES.exportImage, data: { imageUrl: 'https://assets.example/result.png', aspectRatio: '1:1', isGenerating: true, generationStartedAt: 1 } }),
      ],
      edges: [
        { id: 'duplicate-edge', source: 'duplicate-node', target: 'missing-node' },
        { id: 'duplicate-edge', source: 'missing-node', target: 'duplicate-node' },
      ],
    });

    const report = inspectCanvasHealth({ now, stalledAfterMs: 1_000 });
    expect(report.evidence.map((item) => item.code)).toEqual(expect.arrayContaining([
      'missing-media',
      'invalid-node-parameters',
      'duplicate-node-ids',
      'duplicate-edge-ids',
      'dangling-edges',
      'stalled-generation-job',
    ]));
    expect(report.evidence.find((item) => item.code === 'missing-media')).toMatchObject({
      nodeIds: ['duplicate-node'],
      fieldPaths: ['nodes[0].data.imageUrl'],
    });
    expect(report.evidence.find((item) => item.code === 'dangling-edges')?.edgeIds).toEqual(['duplicate-edge', 'duplicate-edge']);
  });

  it('returns provider access state without exposing keys or secret-bearing configuration fields', () => {
    useCustomProvidersStore.setState({
      providers: [{
        id: 'provider-1',
        label: 'Provider',
        mediaType: 'chat',
        baseUrl: 'https://example.test/v1?api_key=should-not-escape',
        endpointPath: '/chat/completions',
        apiKey: 'sk-live-secret',
        apiStyle: 'openai-compatible',
        models: ['model-a'],
        supportsWebSearch: false,
        extraHeaders: { Authorization: 'Bearer should-not-escape' },
      }],
    });
    const result = inspectRedactedProviderConfig();
    const serialized = JSON.stringify(result);
    expect(result).toEqual([expect.objectContaining({ accessState: 'configured' })]);
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).not.toContain('should-not-escape');
    expect(scanForSensitiveOutput(result)).toEqual([]);
  });

  it('returns allowlisted application settings without credential values or Dreamina paths', () => {
    useSettingsStore.setState({
      apiKeys: { grsai: 'secret-built-in-key', empty: '' },
      agnesApiKey: 'secret-agnes-key',
      generationNetworkSettings: {
        route: 'custom-proxy',
        customProxyUrl: 'http://user:secret-proxy-password@127.0.0.1:7890',
      },
      downloadPresetPaths: ['/Users/alice/exports'],
      dreaminaStatus: {
        installed: true,
        loggedIn: true,
        loginState: 'logged_in',
        credits: 12,
        networkDegraded: false,
        resolvedPath: '/Users/alice/bin/dreamina',
        version: '2.0.0',
        commit: 'abc123',
        buildTime: '2026-08-01',
        vipLevel: 'pro',
        accountError: 'Authorization: Bearer secret-account',
        sessionsAvailable: true,
        sessionError: null,
      },
    });

    const application = inspectRedactedApplicationConfig();
    const snapshot = inspectDiagnosticConfigSnapshot();
    const serialized = JSON.stringify({ application, snapshot });
    expect(application).toMatchObject({
      access: { providers: { grsai: 'configured', empty: 'missing' }, agnes: 'configured' },
      dreamina: { installed: true, loginState: 'logged_in', accountErrorState: 'present' },
      generation: { networkRoute: 'custom-proxy', customProxyState: 'configured' },
    });
    expect(serialized).not.toContain('secret-built-in-key');
    expect(serialized).not.toContain('secret-agnes-key');
    expect(serialized).not.toContain('secret-account');
    expect(serialized).not.toContain('secret-proxy-password');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('resolvedPath');
    expect(serialized).not.toContain('downloadPresetPaths');
    expect(scanForSensitiveOutput(snapshot)).toEqual([]);
  });

  it('builds a redacted local bundle and issue draft without a publication action', () => {
    const bundle = buildDiagnosticBundlePreview({
      error: { status: 503, message: 'Service unavailable at /Users/alice/project' },
      evidence: {
        events: [{
          timestamp: 123,
          source: 'provider',
          code: 'request-failed',
          status: 'failed',
          message: `Authorization: Bearer sk-secret ${'a'.repeat(600)}`,
          nodeIds: ['node-1'],
        }],
        lastKnownGoodConfig: { endpointPath: '/responses', apiKey: 'old-secret' },
        currentConfig: { endpointPath: '/chat/completions', apiKey: 'new-secret', image: `data:image/png;base64,${'a'.repeat(600)}` },
      },
      runtimeSnapshot: { appVersion: '1.2.3', localPath: '/Users/alice/project/file.json' },
      reproductionSteps: ['Open /Users/alice/project/file.json', `Paste data:image/png;base64,${'a'.repeat(600)}`],
      now: 456,
    });
    const serialized = JSON.stringify(bundle);
    expect(bundle).toMatchObject({
      version: 1,
      publication: 'draft-only',
      security: { passed: true, findings: [] },
      issueDraft: { title: '[Diagnostic] upstream-server-error' },
    });
    expect(bundle.configSnapshot.diff).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$.endpointPath' }),
    ]));
    expect(bundle.report.eventTimeline).toHaveLength(1);
    expect(bundle.issueDraft.body).toContain('It has not been published');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('old-secret');
    expect(serialized).not.toContain('new-secret');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('a'.repeat(512));
    expect(scanForSensitiveOutput(bundle)).toEqual([]);
  });

  it('exports only a security-approved bundle and strips tool receipt metadata', () => {
    const bundle = buildDiagnosticBundlePreview({
      error: { status: 429, message: 'Too many requests' },
      reproductionSteps: ['Submit the selected generation node'],
      now: 456,
    });
    const wrappedToolOutput = {
      ...bundle,
      execution: { receiptId: 'receipt-with-secret-like-metadata', replayed: false },
    };

    const extracted = extractSafeDiagnosticBundlePreview(wrappedToolOutput);
    const serialized = serializeSafeDiagnosticBundlePreview(wrappedToolOutput);
    const issueDraft = formatDiagnosticIssueDraft(wrappedToolOutput);

    expect(extracted).not.toHaveProperty('execution');
    expect(serialized).not.toContain('receipt-with-secret-like-metadata');
    expect(serialized).toContain('"publication": "draft-only"');
    expect(issueDraft).toContain('[Diagnostic] upstream-rate-limit');
    expect(issueDraft).toContain('It has not been published');
    expect(diagnosticBundleFileName(wrappedToolOutput)).toBe('storyboard-diagnostic-1970-01-01T00-00-00-456Z.json');
    expect(scanForSensitiveOutput(JSON.parse(serialized!))).toEqual([]);

    const blocked = { ...bundle, security: { passed: false, findings: ['unsafe-content-withheld'] } };
    expect(extractSafeDiagnosticBundlePreview(blocked)).toBeNull();
    expect(serializeSafeDiagnosticBundlePreview(blocked)).toBeNull();
    expect(formatDiagnosticIssueDraft(blocked)).toBeNull();
    expect(diagnosticBundleFileName(blocked)).toBeNull();
  });
});
