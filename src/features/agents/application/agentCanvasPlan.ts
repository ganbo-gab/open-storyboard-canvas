import { z } from 'zod';
import { canvasCommandRegistry } from '@/features/canvas/application/canvasCommandService';
import { CANVAS_COMMAND_VERSION, type CanvasCommand } from '@/features/canvas/domain/canvasCommands';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { withCanvasHistoryAgentTurn } from '@/stores/canvasHistory';

export const canvasPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  script: z.string().max(50_000),
  shots: z.array(z.object({
    title: z.string().min(1).max(200),
    prompt: z.string().min(1).max(10_000),
    modelId: z.string().min(1),
    aspectRatio: z.string().min(1),
    resolution: z.string().min(1),
  }).strict()).min(1).max(48),
}).strict();
export type AgentCanvasPlan = z.infer<typeof canvasPlanSchema>;

export async function persistAgentProjectBeforeNavigation(): Promise<void> {
  const project = useProjectStore.getState();
  if (!project.currentProjectId || project.isOpeningProject) return;
  const canvas = useCanvasStore.getState();
  project.saveCurrentProject(canvas.nodes, canvas.edges, canvas.currentViewport, canvas.history);
  await project.waitForProjectPersistence(project.currentProjectId);
}

/** Project loading is asynchronous even though the legacy store action returns void. */
export async function openAgentProject(projectId: string): Promise<void> {
  const store = useProjectStore.getState();
  const alreadyOpen = store.currentProjectId === projectId && !store.isOpeningProject;
  if (!alreadyOpen) {
    await persistAgentProjectBeforeNavigation();
    store.openProject(projectId);
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        const state = useProjectStore.getState();
        if (state.isOpeningProject) return;
        unsubscribe();
        if (state.currentProjectId === projectId) resolve();
        else reject(new Error('项目打开失败或已切换到其他项目。'));
      };
      const unsubscribe = useProjectStore.subscribe(finish);
      finish();
    });
    const project = useProjectStore.getState().getCurrentProject();
    if (!project || project.id !== projectId) throw new Error('目标项目不可用。');
    useCanvasStore.getState().setCanvasData(project.nodes, project.edges, project.history);
  }
}

/** Plan creation is non-paying; opening materializes the entire plan atomically. */
export async function openAgentCanvasPlan(input: { projectId?: string | null; plan: AgentCanvasPlan; agentTurnId?: string }) {
  const plan = canvasPlanSchema.parse(input.plan);
  const store = useProjectStore.getState();
  if (!input.projectId) await persistAgentProjectBeforeNavigation();
  const projectId = input.projectId ?? store.createProject(plan.title);
  if (!input.projectId) useCanvasStore.getState().setCanvasData([], []);
  await useProjectStore.getState().waitForProjectPersistence(projectId);
  await openAgentProject(projectId);
  const canvas = useCanvasStore.getState();
  const originX = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x + (node.width ?? 360)), -160) + 160;
  const scriptId = globalThis.crypto.randomUUID();
  const nodeIds = plan.shots.map(() => globalThis.crypto.randomUUID());
  const commands: CanvasCommand[] = [{
    type: 'node.create', version: CANVAS_COMMAND_VERSION,
    input: { nodeId: scriptId, nodeType: 'textAnnotationNode', position: { x: originX, y: 0 }, configuration: { displayName: plan.title, content: plan.script } },
  }];
  plan.shots.forEach((shot, index) => {
    commands.push({ type: 'node.create', version: CANVAS_COMMAND_VERSION, input: {
      nodeId: nodeIds[index], nodeType: 'imageNode', position: { x: originX + 480 + (index % 4) * 420, y: Math.floor(index / 4) * 400 },
      configuration: { displayName: shot.title, prompt: shot.prompt, modelId: shot.modelId, aspectRatio: shot.aspectRatio, resolution: shot.resolution },
    } }, { type: 'edge.connect', version: CANVAS_COMMAND_VERSION, input: { sourceNodeId: scriptId, targetNodeId: nodeIds[index] } });
  });
  const result = withCanvasHistoryAgentTurn(input.agentTurnId, () => canvasCommandRegistry.executeTransaction({ id: globalThis.crypto.randomUUID(), origin: 'agent', expectedRevision: canvasCommandRegistry.getRevision(), commands }));
  if (!result.ok) throw new Error(result.error.message);
  const next = useCanvasStore.getState();
  useProjectStore.getState().saveCurrentProject(next.nodes, next.edges, next.currentViewport, next.history);
  await useProjectStore.getState().waitForProjectPersistence(projectId);
  return { projectId, scriptNodeId: scriptId, nodeIds, result };
}
