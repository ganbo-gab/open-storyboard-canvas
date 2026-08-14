import { describe, expect, it } from 'vitest';
import {
  executionReceiptFromAgentOutput,
  generationLocateTargetsFromAgentOutput,
  generationProgressFromAgentOutput,
  nodeIdsFromAgentOutput,
} from './agentFeedProjection';

describe('agentFeedProjection', () => {
  it('projects unique node ids from direct and wrapped tool output', () => {
    expect(nodeIdsFromAgentOutput({
      output: {
        references: {
          nodeId: 'node-2',
          nodeIds: ['node-1', 'node-2', '', 42],
        },
      },
    })).toEqual(['node-1', 'node-2']);
  });

  it('projects receipts from command and wrapped execution output', () => {
    expect(executionReceiptFromAgentOutput({
      output: {
        execution: { receiptId: 'receipt-1' },
        rollbackToken: 'rollback-1',
      },
    })).toEqual({ receiptId: 'receipt-1', rollbackToken: 'rollback-1' });
  });

  it('keeps generation input and result locate targets separate', () => {
    expect(generationLocateTargetsFromAgentOutput({
      followThrough: {
        inputNodeIds: ['input-1', 'input-1'],
        resultNodeIds: ['result-1', '', 42],
      },
    })).toEqual({ inputNodeIds: ['input-1'], resultNodeIds: ['result-1'] });
  });

  it('returns empty projections for invalid boundary values', () => {
    expect(nodeIdsFromAgentOutput(['node-1'])).toEqual([]);
    expect(executionReceiptFromAgentOutput(null)).toEqual({});
    expect(generationLocateTargetsFromAgentOutput(null)).toEqual({ inputNodeIds: [], resultNodeIds: [] });
    expect(generationProgressFromAgentOutput(null)).toBeNull();
  });

  it('projects accepted and bounded generation polling progress', () => {
    expect(generationProgressFromAgentOutput({ followThrough: { phase: 'accepted' } })).toEqual({
      phase: 'accepted', attempt: 0, maxAttempts: 0, statuses: [],
    });
    expect(generationProgressFromAgentOutput({
      followThrough: {
        phase: 'generation-follow-through',
        attempt: 7,
        maxAttempts: 72,
        statuses: ['running'],
      },
    })).toEqual({ phase: 'polling', attempt: 7, maxAttempts: 72, statuses: ['running'] });
  });
});
