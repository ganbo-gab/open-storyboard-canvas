import { describe, expect, it } from 'vitest';
import type { LocalDocument } from '@/features/workbench/application/workbenchPersistence';
import { createAgentSkillRecencyStore, type AgentSkillRecencyData } from './agentSkillRecency';

function persistedDocuments() {
  let persisted: AgentSkillRecencyData = { recentBySurface: { home: [], canvas: [], stage: [] } };
  return (): LocalDocument<AgentSkillRecencyData> => {
    let snapshot: AgentSkillRecencyData = { recentBySurface: { home: [], canvas: [], stage: [] } };
    return {
      initialize: async () => { snapshot = structuredClone(persisted); },
      load: () => structuredClone(snapshot),
      save: (next) => { snapshot = structuredClone(next); },
      flush: async () => { persisted = structuredClone(snapshot); },
      status: () => ({ mode: 'persistent' }),
    };
  };
}

describe('Agent skill recency', () => {
  it('rehydrates used built-in and user skills from a persisted document', async () => {
    const createDocument = persistedDocuments();
    const original = createAgentSkillRecencyStore(createDocument());
    await original.getState().recordUse('home', ['storyboard-planning']);
    await original.getState().recordUse('home', ['user-skill-continuity']);

    const restored = createAgentSkillRecencyStore(createDocument());
    await restored.getState().initialize();

    expect(restored.getState().recentBySurface.home).toEqual(['user-skill-continuity', 'storyboard-planning']);
  });

  it('moves reused skills to the front without duplicating rows, including duplicates within a send', async () => {
    const store = createAgentSkillRecencyStore(persistedDocuments()());
    await store.getState().recordUse('canvas', ['canvas-orchestration', 'user-skill-continuity']);
    await store.getState().recordUse('canvas', ['image-prompt-director']);
    await store.getState().recordUse('canvas', ['user-skill-continuity', 'user-skill-continuity']);

    expect(store.getState().recentBySurface.canvas).toEqual(['user-skill-continuity', 'image-prompt-director', 'canvas-orchestration']);
  });

  it('keeps each surface independent even when the same skill is used across surfaces', async () => {
    const createDocument = persistedDocuments();
    const store = createAgentSkillRecencyStore(createDocument());
    await store.getState().recordUse('home', ['image-prompt-director']);
    await store.getState().recordUse('canvas', ['canvas-orchestration']);
    await store.getState().recordUse('stage', ['director-studio', 'image-prompt-director']);
    await store.getState().recordUse('home', ['user-skill-continuity']);

    const restored = createAgentSkillRecencyStore(createDocument());
    await restored.getState().initialize();

    expect(restored.getState().recentBySurface).toEqual({
      home: ['user-skill-continuity', 'image-prompt-director'],
      canvas: ['canvas-orchestration'],
      stage: ['director-studio', 'image-prompt-director'],
    });
  });

  it('preserves persisted recency when recording an empty selection before initialization', async () => {
    const createDocument = persistedDocuments();
    const original = createAgentSkillRecencyStore(createDocument());
    await original.getState().recordUse('home', ['storyboard-planning']);

    const next = createAgentSkillRecencyStore(createDocument());
    await next.getState().recordUse('home', []);
    expect(next.getState().initialized).toBe(false);
    await next.getState().initialize();

    expect(next.getState().recentBySurface.home).toEqual(['storyboard-planning']);
    const restored = createAgentSkillRecencyStore(createDocument());
    await restored.getState().initialize();
    expect(restored.getState().recentBySurface.home).toEqual(['storyboard-planning']);
  });

  it('preserves earlier persisted uses and concurrent sends while initialization is pending', async () => {
    const createDocument = persistedDocuments();
    const original = createAgentSkillRecencyStore(createDocument());
    await original.getState().recordUse('canvas', ['canvas-orchestration']);

    const next = createAgentSkillRecencyStore(createDocument());
    await Promise.all([
      next.getState().recordUse('canvas', ['storyboard-planning']),
      next.getState().recordUse('canvas', ['user-skill-continuity']),
    ]);

    const restored = createAgentSkillRecencyStore(createDocument());
    await restored.getState().initialize();
    expect(restored.getState().recentBySurface.canvas).toEqual(['user-skill-continuity', 'storyboard-planning', 'canvas-orchestration']);
  });
});
