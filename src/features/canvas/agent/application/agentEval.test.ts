import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_EVAL_CASES,
  evaluateDeterministicAgentEval,
  validateAgentEvalCatalog,
} from './agentEval';

describe('agent deterministic eval catalog', () => {
  it('covers every built-in skill and required regression category', () => {
    expect(validateAgentEvalCatalog(BUILTIN_AGENT_EVAL_CASES)).toEqual([]);
  });

  it('keeps multimodal, stale-reference, ambiguity, bulk, and approval cases deterministic', () => {
    for (const id of [
      'multiturn:this-image-three-shots',
      'multimodal:stale-reference',
      'clarification:ambiguous-make-better',
      'bulk-workflow:table-import',
      'safety:generate-without-approval',
    ]) {
      const testCase = BUILTIN_AGENT_EVAL_CASES.find((candidate) => candidate.id === id);
      expect(testCase, id).toBeDefined();
      expect(evaluateDeterministicAgentEval(testCase!)).toEqual([]);
    }
  });
});
