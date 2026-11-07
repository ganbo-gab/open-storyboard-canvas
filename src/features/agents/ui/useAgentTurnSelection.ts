import { useMemo, useState } from 'react';
import { useChatModelCatalog, type ChatCatalogEntry } from '@/features/canvas/application/chatModelCatalog';
import { getCanvasAgentSession } from '@/features/canvas/agent/application/canvasAgentController';
import type { CanvasAgentExecutionMode } from '@/features/canvas/agent/application/agentAutoApprovalPolicy';
import { resolveAgentDefaults, useSettingsStore } from '@/stores/settingsStore';

export type AgentSelectionSource = 'selection' | 'session' | 'default';
/** Why no model can run the next turn; the UI asks for a choice instead of switching channels. */
export type AgentModelIssue = 'unset' | 'missing' | 'unavailable' | 'no-tools';

export interface AgentTurnSelection {
  /** Usable, tool-capable chat models the user may pick for this turn. */
  models: ChatCatalogEntry[];
  /** The model the next turn runs on; null whenever the resolved choice cannot run. */
  model: ChatCatalogEntry | null;
  /** Catalog entry behind the resolved id, kept even when it cannot run so the UI can name it. */
  requestedModel: ChatCatalogEntry | null;
  modelSource: AgentSelectionSource;
  modelIssue: AgentModelIssue | null;
  executionMode: CanvasAgentExecutionMode;
  modeSource: AgentSelectionSource;
}

export interface AgentTurnSelectionState extends AgentTurnSelection {
  selectModel(modelId: string): void;
  selectMode(mode: CanvasAgentExecutionMode): void;
}

interface ExplicitSelection {
  modelId?: string;
  executionMode?: CanvasAgentExecutionMode;
}

/**
 * 06 §2 precedence for each field: explicit choice for this turn > saved conversation > global
 * defaults. A null, deleted, unusable or tool-less model is reported, never replaced by another one.
 */
export function resolveAgentTurnSelection(input: {
  catalog: readonly ChatCatalogEntry[];
  explicit: ExplicitSelection;
  session: { modelRef?: string; executionMode?: CanvasAgentExecutionMode } | null;
}): AgentTurnSelection {
  const sessionModelId = input.session?.modelRef?.trim() || undefined;
  const sessionMode = input.session?.executionMode;
  const resolved = resolveAgentDefaults({
    modelId: input.explicit.modelId ?? sessionModelId,
    executionMode: input.explicit.executionMode ?? sessionMode,
  });
  const requestedModel = resolved.modelId
    ? input.catalog.find((entry) => entry.id === resolved.modelId) ?? null
    : null;
  const modelIssue: AgentModelIssue | null = !resolved.modelId
    ? 'unset'
    : !requestedModel
      ? 'missing'
      : !requestedModel.usable
        ? 'unavailable'
        : !requestedModel.supportsTools
          ? 'no-tools'
          : null;
  return {
    models: input.catalog.filter((entry) => entry.usable && entry.supportsTools),
    model: modelIssue ? null : requestedModel,
    requestedModel,
    modelSource: input.explicit.modelId ? 'selection' : sessionModelId ? 'session' : 'default',
    modelIssue,
    executionMode: resolved.executionMode,
    modeSource: input.explicit.executionMode ? 'selection' : sessionMode ? 'session' : 'default',
  };
}

/**
 * Explicit picks belong to the conversation they were made in: opening another conversation or
 * starting a new one returns to that conversation's saved choice or the global default.
 * `revision` re-reads the saved conversation after a turn updates its metadata.
 */
export function useAgentTurnSelection(sessionId: string | null | undefined, revision: string): AgentTurnSelectionState {
  const catalog = useChatModelCatalog();
  const agentDefaults = useSettingsStore((state) => state.agentDefaults);
  const key = sessionId ?? null;
  const [explicit, setExplicit] = useState<ExplicitSelection & { key: string | null }>({ key });
  const current = explicit.key === key ? explicit : null;
  const session = useMemo(
    () => (key ? getCanvasAgentSession(key) : null),
    // `revision` marks turn boundaries where the controller rewrites the session metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, revision],
  );
  const selection = useMemo(
    () => resolveAgentTurnSelection({
      catalog,
      explicit: { modelId: current?.modelId, executionMode: current?.executionMode },
      session,
    }),
    // agentDefaults is read through resolveAgentDefaults; it is listed so default edits re-resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, current?.modelId, current?.executionMode, session, agentDefaults],
  );
  return {
    ...selection,
    selectModel: (modelId) => setExplicit((previous) => ({ ...(previous.key === key ? previous : { key }), modelId })),
    selectMode: (executionMode) => setExplicit((previous) => ({ ...(previous.key === key ? previous : { key }), executionMode })),
  };
}
