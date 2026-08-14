import { describe, expect, it } from 'vitest';

import {
  explainInvalidCanvasAgentCommand,
  hasVisibleCanvasAgentSessionItems,
  prepareCanvasAgentToolApproval,
  rememberInvalidCanvasAgentRequest,
} from './canvasAgentController';

describe('Canvas Agent approval preflight', () => {
  it('rejects generation.submit without nodeIds before an approval card is created', async () => {
    await expect(prepareCanvasAgentToolApproval({
      runId: 'run-invalid-generation',
      projectId: 'project',
      callId: 'call-1',
      toolName: 'canvas_command',
      arguments: { type: 'generation.submit', input: {} },
    })).rejects.toThrow(/nodeIds|required|validation/i);
  });

  it('rejects canvas.query without scope before an approval card is created', async () => {
    await expect(prepareCanvasAgentToolApproval({
      runId: 'run-invalid-query',
      projectId: 'project',
      callId: 'call-2',
      toolName: 'canvas_command',
      arguments: { type: 'canvas.query', input: { limit: 100 } },
    })).rejects.toThrow(/scope|validation/i);
  });

  it('returns exact repair contracts for malformed generation, creation, and query calls', () => {
    expect(explainInvalidCanvasAgentCommand('canvas_command', {
      type: 'generation.submit', input: { prompt: 'girl' },
    })).toMatch(/node\.create.*nodeId.*generation\.submit.*不接受 prompt/s);
    expect(explainInvalidCanvasAgentCommand('canvas_command', {
      type: 'canvas.query', input: { filter: 'all' },
    })).toMatch(/scope.*graph\|nodes\|edges\|selection.*不存在 filter/s);
    expect(explainInvalidCanvasAgentCommand('canvas_command', {
      type: 'node.create',
      input: {
        nodeType: 'image',
        position: { x: 0, y: 0 },
        configuration: { prompt: 'girl', aspectRatio: '16:9', resolution: '2K' },
      },
    })).toMatch(/nodeType":"imageNode".*aspectRatio.*resolution.*不要写 image.*不要.*自造 nodeId/s);
  });

  it('stops a repeated invalid request even when object keys arrive in a different order', async () => {
    const rejected = new Set<string>();
    await rememberInvalidCanvasAgentRequest(rejected, 'canvas_command', {
      type: 'canvas.query', input: { filter: 'all', limit: 100 },
    });
    await expect(rememberInvalidCanvasAgentRequest(rejected, 'canvas_command', {
      input: { limit: 100, filter: 'all' }, type: 'canvas.query',
    })).rejects.toThrow(/纠正机会.*安全停止.*模型配额/s);
  });

  it('allows only one repair attempt for a command type even when the guessed fields change', async () => {
    const rejected = new Set<string>();
    await rememberInvalidCanvasAgentRequest(rejected, 'canvas_command', {
      type: 'node.create',
      input: { nodeType: 'image', position: { x: 0, y: 0 } },
    });
    await expect(rememberInvalidCanvasAgentRequest(rejected, 'canvas_command', {
      type: 'node.create',
      input: { nodeType: 'imageEditNode', position: { x: 100, y: 100 } },
    })).rejects.toThrow(/node\.create.*纠正机会.*模型配额/s);
  });

  it('hides orphan history sessions while preserving user and assistant conversations', () => {
    expect(hasVisibleCanvasAgentSessionItems([])).toBe(false);
    expect(hasVisibleCanvasAgentSessionItems([{
      type: 'function_call',
      name: 'canvas_command',
      callId: 'call-1',
      arguments: '{}',
    }])).toBe(false);
    expect(hasVisibleCanvasAgentSessionItems([{
      type: 'message',
      role: 'user',
      content: '你好',
    }])).toBe(true);
    expect(hasVisibleCanvasAgentSessionItems([{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '你好！' }],
    }])).toBe(true);
  });
});
