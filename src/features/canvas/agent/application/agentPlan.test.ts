import { describe, expect, it } from 'vitest';
import {
  buildAgentPlanDraft,
  classifyAgentPlanStep,
  compileAgentPlanMessage,
  reviseAgentPlan,
  updateAgentPlanStep,
} from './agentPlan';

describe('agent editable plans', () => {
  it('builds a bounded multi-step plan and classifies effects', () => {
    const plan = buildAgentPlanDraft('先检查当前画布，然后创建三个分镜节点，并且生成图片', 10);
    expect(plan).not.toBeNull();
    expect(plan?.steps.map((step) => step.effect)).toEqual([
      'read',
      'canvas-write',
      'external-submit',
    ]);
    expect(plan?.createdAt).toBe(10);
  });

  it('does not interrupt a single-step request with a plan card', () => {
    expect(buildAgentPlanDraft('把节点 A 重命名为开场镜头')).toBeNull();
  });

  it('increments revisions and compiles only the edited steps', () => {
    const plan = buildAgentPlanDraft('检查画布，然后生成图片')!;
    const edited = reviseAgentPlan(plan, [
      updateAgentPlanStep(plan.steps[0], { title: '只检查节点 A' }),
    ]);
    expect(edited.revision).toBe(2);
    expect(compileAgentPlanMessage(edited)).toContain('1. [read] 只检查节点 A');
    expect(compileAgentPlanMessage(edited)).not.toContain('生成图片');
    expect(compileAgentPlanMessage(edited)).toContain('current Manual/Auto execution policy');
    expect(compileAgentPlanMessage(edited)).toContain('node-deletion approval');
  });

  it('reclassifies edits unless the user explicitly changes the effect', () => {
    expect(classifyAgentPlanStep('查看设置')).toBe('config-write');
    const plan = buildAgentPlanDraft('查看画布，然后创建节点')!;
    expect(updateAgentPlanStep(plan.steps[0], { title: '提交生成' }).effect).toBe('external-submit');
    expect(updateAgentPlanStep(plan.steps[0], { title: '提交生成', effect: 'read' }).effect).toBe('read');
  });
});
