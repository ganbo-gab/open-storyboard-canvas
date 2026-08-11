import { describe, expect, it } from 'vitest';
import {
  executionReceiptFromAgentOutput,
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

  it('returns empty projections for invalid boundary values', () => {
    expect(nodeIdsFromAgentOutput(['node-1'])).toEqual([]);
    expect(executionReceiptFromAgentOutput(null)).toEqual({});
  });
});
