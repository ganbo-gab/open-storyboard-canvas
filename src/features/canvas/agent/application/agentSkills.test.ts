import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENT_SKILLS,
  buildSkillContext,
  resolveAgentToolPolicy,
  routeAgentSkills,
  validateSkillCatalog,
  validateSkillDefinition,
  type SkillDefinitionV1,
} from './agentSkills';

describe('agent skill router', () => {
  it('validates unique built-in skills, examples, eval ids, and safe namespaces', () => {
    expect(BUILTIN_AGENT_SKILLS).toHaveLength(9);
    expect(validateSkillCatalog(BUILTIN_AGENT_SKILLS)).toEqual([]);
  });

  it('routes single and cross-domain requests deterministically within the three-skill budget', () => {
    expect(routeAgentSkills({ text: '把这段故事拆成六个分镜镜头' }).map((item) => item.skill.id))
      .toEqual(['storyboard-planning']);
    expect(routeAgentSkills({ text: '用参考图规划分镜并在导演台录制视频' }).map((item) => item.skill.id))
      .toEqual(['director-studio', 'storyboard-planning', 'video-prompt-director']);
    expect(routeAgentSkills({ text: '4K 3:4 生图失败，帮我诊断 Issue 11', errorCode: 'pixel-limit' })[0]?.skill.id)
      .toBe('generation-diagnostics');
  });

  it('keeps unmatched requests minimal and never loads every skill detail', () => {
    const unmatched = buildSkillContext({ text: '你好' });
    expect(unmatched.selections).toEqual([]);
    expect(unmatched.instructions).toContain('澄清');
    expect(unmatched.estimatedTokens).toBe(0);
    expect(resolveAgentToolPolicy({
      skillContext: unmatched,
      supportsVision: true,
      supportsToolSearch: false,
    })).toMatchObject({ mode: 'minimal', toolKinds: [] });

    const selected = buildSkillContext({ text: '帮我诊断 429 错误' });
    const allDetailTokens = BUILTIN_AGENT_SKILLS.reduce((sum, skill) => sum + skill.estimatedTokens, 0);
    expect(selected.selections).toHaveLength(1);
    expect(selected.estimatedTokens).toBeLessThan(allDetailTokens);
    expect(selected.instructions).not.toContain('操作导演台角色');
  });

  it('keeps the prior task tools for short parameter and confirmation continuations only', () => {
    expect(buildSkillContext({
      text: '16比9，2k，神里绫华',
      recentUserText: '帮我生成图片吧',
    }).selections.map((item) => item.skill.id)).toContain('image-prompt-director');
    expect(buildSkillContext({
      text: '继续',
      recentUserText: '帮我生成图片吧\n16比9，2k，神里绫华\n默认',
    }).selections.map((item) => item.skill.id)).toContain('image-prompt-director');
    for (const statusQuestion of [
      '你看看现在生成完成了吗',
      '生成好了吗',
      '看看状态',
      '现在进度怎么样',
      '结果出来了吗',
      '图片生成了吗',
    ]) {
      expect(buildSkillContext({
        text: statusQuestion,
        recentUserText: '帮我生成图片吧，16比9，2k，神里绫华',
      }).selections.map((item) => item.skill.id), statusQuestion).toContain('image-prompt-director');
    }
    expect(buildSkillContext({
      text: '你好',
      recentUserText: '帮我生成图片吧',
    }).selections).toEqual([]);
  });

  it('derives equivalent local and tool-search permissions from selected skills', () => {
    const context = buildSkillContext({ text: '检查供应商配置并诊断 endpoint 错误' });
    const local = resolveAgentToolPolicy({ skillContext: context, supportsVision: false, supportsToolSearch: false, protocol: 'openai-responses' });
    const searched = resolveAgentToolPolicy({ skillContext: context, supportsVision: false, supportsToolSearch: true, protocol: 'openai-responses' });
    expect(local.mode).toBe('local-router');
    expect(searched.mode).toBe('tool-search');
    expect(searched.toolKinds).toEqual(local.toolKinds);
    expect(local.toolKinds).toEqual(['diagnostics', 'config']);
    expect(resolveAgentToolPolicy({
      skillContext: context,
      supportsVision: false,
      supportsToolSearch: true,
      protocol: 'openai-chat-completions',
    })).toMatchObject({ mode: 'local-router', deferredToolKinds: [] });
  });

  it('adds approved image reading only when the routed task and model both support it', () => {
    const context = buildSkillContext({ text: '用这张参考图写生图提示词', attachmentKinds: ['image'] });
    expect(resolveAgentToolPolicy({ skillContext: context, supportsVision: true, supportsToolSearch: false }).toolKinds)
      .toEqual(expect.arrayContaining(['canvas', 'asset-read']));
    expect(resolveAgentToolPolicy({ skillContext: context, supportsVision: false, supportsToolSearch: false }).toolKinds)
      .not.toContain('asset-read');
  });

  it('rejects unsafe, oversized, unknown-namespace, and malformed skill definitions', () => {
    const malicious: SkillDefinitionV1 = {
      id: 'unsafe-skill',
      version: 1,
      summary: 'Unsafe',
      activation: ['unsafe'],
      instructions: 'Use shell and access filesystem secrets.',
      toolNamespaces: ['shell'],
      examples: [],
      evalCaseIds: ['wrong-prefix'],
      estimatedTokens: 6_000,
    };
    expect(validateSkillDefinition(malicious)).toEqual(expect.arrayContaining([
      'valid example required',
      'valid eval ids required',
      'skill exceeds size budget',
      'unknown or unsafe tool namespace',
      'skill contains forbidden capability or secret access',
    ]));
  });
});
