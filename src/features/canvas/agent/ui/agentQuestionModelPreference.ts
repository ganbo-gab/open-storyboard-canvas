import { getAgentGenerationCatalog } from '../application/agentGenerationCatalog';
import { readAgentUserInputAnswer, requestUserInputSchema, type AgentQuestionBinding } from '../application/agentUserInput';
import { useCanvasAgentPanelStore, type AgentFeedItem } from './agentPanelStore';

/** Remember explicit catalog IDs from this answered card before resuming the model. */
export function applyAgentQuestionModelPreference(
  item: Extract<AgentFeedItem, { kind: 'approval' }>,
  binding: AgentQuestionBinding,
): void {
  if (item.toolName !== 'request_user_input' || item.status !== 'pending' || item.expiresAt <= Date.now()) return;
  const request = requestUserInputSchema.safeParse(item.arguments);
  if (!request.success) return;
  const answers = readAgentUserInputAnswer(binding, request.data);
  if (!answers) return;
  const values = new Set(request.data.questions.flatMap(question => {
    const value = answers[question.id];
    return question.options.some(option => option.value === value) ? [value] : [];
  }));
  const catalog = getAgentGenerationCatalog();
  const image = catalog.image.filter(entry => values.has(entry.modelId));
  const video = catalog.video.filter(entry => values.has(entry.modelId));
  const panel = useCanvasAgentPanelStore.getState();
  // Multiple answers naming different models do not establish one preferred model.
  if (image.length === 1) panel.setSelectedImageModelId(image[0].modelId);
  if (video.length === 1) panel.setSelectedVideoModelId(video[0].modelId);
}
