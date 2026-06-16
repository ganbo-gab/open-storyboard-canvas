import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import {
  parseAgentJsonExample,
  resolveJsonCardDisplayFields,
} from '@/features/canvas/application/aiText/helpers';
import type {
  AiTextInputSourceType,
  TextAgentConfig,
  TextAgentInputConfig,
} from '@/features/canvas/application/aiText/types';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { UiButton, UiCheckbox, UiInput, UiSelect, UiTextArea } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type DraftAgent = TextAgentConfig;
type AgentSourceType = Extract<AiTextInputSourceType, 'markdown' | 'json'>;

function createSource(type: AgentSourceType, index: number): TextAgentInputConfig {
  return {
    id: `draft-source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    label: type === 'json' ? `JSON 来源 ${index}` : `文本来源 ${index}`,
    sourceAgentId: null,
    jsonPath: type === 'json' ? '$' : undefined,
    enabled: true,
  };
}

function cloneAgent(agent: TextAgentConfig): DraftAgent {
  return {
    ...agent,
    inputSources: agent.inputSources.map((item) => ({
      ...item,
      type: item.type === 'json' ? 'json' : 'markdown',
    })),
    jsonFields: agent.jsonFields.map((item) => ({ ...item })),
  };
}

function normalizeDraft(agent: DraftAgent): DraftAgent {
  return {
    ...agent,
    name: agent.name.trim() || '未命名 Agent',
    prompt: agent.prompt,
    defaultModel: agent.defaultModel?.trim() || 'gpt-4.1-mini',
    inputSources: agent.inputSources.map((item, index) => {
      const type: AgentSourceType = item.type === 'json' ? 'json' : 'markdown';
      return {
        ...item,
        type,
        label: type === 'json' ? `JSON 来源 ${index + 1}` : `文本来源 ${index + 1}`,
        sourceAgentId: item.sourceAgentId ?? null,
        jsonPath: type === 'json' ? (item.jsonPath?.trim() || '$') : undefined,
      };
    }),
    jsonFields: agent.jsonFields.map((item) => ({
      ...item,
      label: item.label.trim() || item.path,
    })),
  };
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0
    || fromIndex >= items.length
    || toIndex < 0
    || toIndex >= items.length
    || fromIndex === toIndex
  ) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function moveJsonField(
  fields: DraftAgent['jsonFields'],
  fieldId: string,
  direction: -1 | 1
): DraftAgent['jsonFields'] {
  const enabledFields = fields.filter((field) => field.enabled);
  const enabledIndex = enabledFields.findIndex((field) => field.id === fieldId);
  const targetField = enabledFields[enabledIndex + direction];
  if (enabledIndex < 0 || !targetField) {
    return fields;
  }
  return moveArrayItem(
    fields,
    fields.findIndex((field) => field.id === fieldId),
    fields.findIndex((field) => field.id === targetField.id)
  );
}

export function TextAgentsSection() {
  const textAgents = useSettingsStore((state) => state.textAgents);
  const addTextAgent = useSettingsStore((state) => state.addTextAgent);
  const updateTextAgent = useSettingsStore((state) => state.updateTextAgent);
  const moveTextAgent = useSettingsStore((state) => state.moveTextAgent);
  const deleteTextAgent = useSettingsStore((state) => state.deleteTextAgent);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(textAgents[0]?.id ?? null);
  const [draft, setDraft] = useState<DraftAgent | null>(textAgents[0] ? cloneAgent(textAgents[0]) : null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (textAgents.length === 0) {
      setSelectedAgentId(null);
      setDraft(null);
      return;
    }

    const nextSelectedId = selectedAgentId && textAgents.some((agent) => agent.id === selectedAgentId)
      ? selectedAgentId
      : textAgents[0].id;
    setSelectedAgentId(nextSelectedId);
    const nextAgent = textAgents.find((agent) => agent.id === nextSelectedId) ?? textAgents[0];
    setDraft((previous) => {
      if (previous && previous.id === nextAgent.id) {
        return previous;
      }
      return cloneAgent(nextAgent);
    });
  }, [selectedAgentId, textAgents]);

  const selectableSourceAgents = useMemo(
    () => textAgents.filter((agent) => agent.id !== draft?.id),
    [draft?.id, textAgents]
  );

  const jsonExampleState = useMemo(
    () => parseAgentJsonExample(draft?.jsonExample ?? ''),
    [draft?.jsonExample]
  );

  const saveDraft = () => {
    if (!draft) {
      return;
    }
    if (!draft.prompt.trim()) {
      setError('Agent prompt 为必填项');
      return;
    }
    const normalized = normalizeDraft(draft);
    setError('');
    updateTextAgent(draft.id, normalized);
    canvasNodes
      .filter((node) =>
        node.type === CANVAS_NODE_TYPES.jsonCard
        && node.data.sourceAgentId === normalized.id
        && node.data.parsedJson !== null
        && node.data.parsedJson !== undefined
      )
      .forEach((node) => {
        updateNodeData(node.id, {
          displayFields: resolveJsonCardDisplayFields(normalized, node.data.parsedJson),
        });
      });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };

  const handleCreate = () => {
    const created = addTextAgent();
    setSelectedAgentId(created.id);
    setDraft(cloneAgent(created));
    setError('');
  };

  const handleDelete = () => {
    if (!draft) {
      return;
    }
    deleteTextAgent(draft.id);
    setError('');
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-border-dark bg-bg-dark">
        <div className="flex items-start justify-between gap-3 border-b border-border-dark px-4 py-4">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-dark">AI 文本 Agent</div>
            <div className="mt-1 text-xs leading-5 text-text-muted">配置节点使用的系统提示词与输入映射</div>
          </div>
          <UiButton
            type="button"
            variant="primary"
            size="sm"
            className="shrink-0 gap-1.5 whitespace-nowrap px-2.5"
            onClick={handleCreate}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>新建</span>
          </UiButton>
        </div>

        <div className="ui-scrollbar flex-1 overflow-y-auto p-3">
          {textAgents.length > 0 ? textAgents.map((agent, agentIndex) => (
            <div
              key={agent.id}
              className={`mb-2 rounded-lg border transition-colors ${
                selectedAgentId === agent.id
                  ? 'border-accent/60 bg-accent/10'
                  : 'border-border-dark bg-surface-dark hover:border-[rgba(255,255,255,0.2)]'
              }`}
            >
              <div className="flex items-start gap-2 px-3 py-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setSelectedAgentId(agent.id);
                    setDraft(cloneAgent(agent));
                    setError('');
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-dark">{agent.name}</div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                      agent.enabled
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-white/8 text-text-muted'
                    }`}>
                      {agent.enabled ? '启用' : '停用'}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[11px] text-text-muted">
                    {agent.prompt || '未填写 Agent prompt'}
                  </div>
                </button>
                <span className="mt-0.5 flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label="上移 Agent"
                    title="上移 Agent"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border-dark bg-bg-dark/70 text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark disabled:pointer-events-none disabled:opacity-35"
                    disabled={agentIndex === 0}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveTextAgent(agent.id, -1);
                    }}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="下移 Agent"
                    title="下移 Agent"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border-dark bg-bg-dark/70 text-text-muted transition-colors hover:border-accent/45 hover:text-text-dark disabled:pointer-events-none disabled:opacity-35"
                    disabled={agentIndex === textAgents.length - 1}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveTextAgent(agent.id, 1);
                    }}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            </div>
          )) : (
            <div className="rounded-lg border border-dashed border-border-dark bg-surface-dark/60 p-4 text-sm text-text-muted">
              还没有 Agent，先建一个。
            </div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!draft ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-text-muted">
            新建一个 Agent 后，这里会出现配置面板。
          </div>
        ) : (
          <>
            <div className="border-b border-border-dark px-6 py-5">
              <h2 className="text-lg font-semibold text-text-dark">Agent 配置</h2>
              <p className="mt-1 text-sm text-text-muted">这个配置会被 AI 文本节点引用。</p>
            </div>

            <div className="ui-scrollbar flex-1 overflow-y-auto p-6">
              <div className="flex flex-col gap-5">
                <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                  <div className="grid gap-3">
                    <label className="text-xs font-medium text-text-muted">
                      Agent 名称
                      <UiInput
                        value={draft.name}
                        onChange={(event) => setDraft((previous) => previous ? ({
                          ...previous,
                          name: event.target.value,
                        }) : previous)}
                        className="mt-2 h-9"
                      />
                    </label>

                    <label className="flex items-center gap-2 rounded-lg border border-border-dark bg-surface-dark px-3 py-2 text-xs text-text-muted">
                      <UiCheckbox
                        checked={draft.enabled}
                        onCheckedChange={(checked) => setDraft((previous) => previous ? ({
                          ...previous,
                          enabled: checked,
                        }) : previous)}
                      />
                      启用后在 AI 文本节点中显示
                    </label>

                    <label className="text-xs font-medium text-text-muted">
                      Agent prompt
                      <UiTextArea
                        value={draft.prompt}
                        onChange={(event) => setDraft((previous) => previous ? ({
                          ...previous,
                          prompt: event.target.value,
                        }) : previous)}
                        className="mt-2 h-36"
                        placeholder="这里填写系统提示词"
                      />
                    </label>
                  </div>
                </div>

                <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-text-dark">输入来源配置</h3>
                      <p className="mt-1 text-xs text-text-muted">
                        多个来源会按顺序自动合并为当前 Agent 的输入；上游 Agent 为空时使用画布连接输入。
                      </p>
                    </div>
                    <UiButton
                      type="button"
                      variant="muted"
                      size="sm"
                      className="shrink-0 gap-1.5 whitespace-nowrap"
                      onClick={() => setDraft((previous) => previous ? ({
                        ...previous,
                        inputSources: [
                          ...previous.inputSources,
                          createSource('markdown', previous.inputSources.length + 1),
                        ],
                      }) : previous)}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      添加来源
                    </UiButton>
                  </div>

                  <div className="mt-4 flex flex-col gap-3">
                    {draft.inputSources.map((source, sourceIndex) => (
                      <div
                        key={source.id}
                        className="rounded-lg border border-border-dark bg-surface-dark p-3"
                      >
                        <div className="grid items-end gap-3 md:grid-cols-[minmax(132px,1.2fr)_minmax(116px,0.9fr)_minmax(120px,1fr)_96px]">
                          <label className="min-w-0 text-xs font-medium text-text-muted">
                            上游 Agent
                            <UiSelect
                              value={source.sourceAgentId ?? ''}
                              onChange={(event) => setDraft((previous) => previous ? ({
                                ...previous,
                                inputSources: previous.inputSources.map((item) => item.id === source.id
                                  ? { ...item, sourceAgentId: event.target.value || null }
                                  : item),
                              }) : previous)}
                              className="mt-2"
                              aria-label="上游 Agent"
                            >
                              <option value="">画布连接</option>
                              {selectableSourceAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>{agent.name}</option>
                              ))}
                            </UiSelect>
                          </label>

                          <label className="min-w-0 text-xs font-medium text-text-muted">
                            来源
                            <UiSelect
                              value={source.type === 'json' ? 'json' : 'markdown'}
                              onChange={(event) => setDraft((previous) => previous ? ({
                                ...previous,
                                inputSources: previous.inputSources.map((item, index) => {
                                  if (item.id !== source.id) {
                                    return item;
                                  }
                                  const nextType = event.target.value as AgentSourceType;
                                  return {
                                    ...item,
                                    type: nextType,
                                    label: nextType === 'json' ? `JSON 来源 ${index + 1}` : `文本来源 ${index + 1}`,
                                    jsonPath: nextType === 'json' ? (item.jsonPath ?? '$') : undefined,
                                  };
                                }),
                              }) : previous)}
                              className="mt-2"
                              aria-label="来源"
                            >
                              <option value="markdown">文本</option>
                              <option value="json">JSON</option>
                            </UiSelect>
                          </label>

                          <label className="min-w-0 text-xs font-medium text-text-muted">
                            JSONPath
                            <UiInput
                              value={source.type === 'json' ? (source.jsonPath ?? '') : ''}
                              onChange={(event) => setDraft((previous) => previous ? ({
                                ...previous,
                                inputSources: previous.inputSources.map((item) => item.id === source.id
                                  ? { ...item, jsonPath: event.target.value }
                                  : item),
                              }) : previous)}
                              className="mt-2 h-9"
                              disabled={source.type !== 'json'}
                              placeholder={source.type === 'json' ? '$.data' : ''}
                            />
                          </label>

                          <div className="flex h-9 items-center justify-end gap-2">
                            <button
                              type="button"
                              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-border-dark bg-surface-dark text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                              onClick={() => setDraft((previous) => previous ? ({
                                ...previous,
                                inputSources: previous.inputSources.filter((item) => item.id !== source.id),
                              }) : previous)}
                              title="删除来源"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                            <label className="flex shrink-0 items-center gap-1.5 text-xs text-text-muted">
                              <UiCheckbox
                                checked={source.enabled}
                                onCheckedChange={(checked) => setDraft((previous) => previous ? ({
                                  ...previous,
                                  inputSources: previous.inputSources.map((item) => item.id === source.id
                                    ? { ...item, enabled: checked }
                                    : item),
                                }) : previous)}
                              />
                              启用
                            </label>
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] text-text-muted">
                          来源 {sourceIndex + 1} 会与其他已启用来源一起合并输入。
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-border-dark bg-bg-dark p-4">
                  <h3 className="text-sm font-medium text-text-dark">JSON 示例与展示字段</h3>
                  <p className="mt-1 text-xs text-text-muted">
                    这里的示例只用于解析可展示字段，不影响原始 JSON 保存。
                  </p>

                  <label className="mt-4 block text-xs font-medium text-text-muted">
                    JSON 示例
                    <UiTextArea
                      value={draft.jsonExample}
                      onChange={(event) => setDraft((previous) => previous ? ({
                        ...previous,
                        jsonExample: event.target.value,
                      }) : previous)}
                      className="mt-2 h-40 font-mono"
                      placeholder={'{\n  "data": "示例文本",\n  "characters": [{ "name": "张三" }]\n}'}
                    />
                  </label>

                  {jsonExampleState.error ? (
                    <div className="mt-3 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      JSON 示例解析失败: {jsonExampleState.error}
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <div className="mb-2 text-xs font-medium text-text-muted">JSON 卡片展示项</div>
                    {draft.jsonFields.filter((field) => field.enabled).length > 0 ? (
                      <div className="mb-4 rounded-lg border border-border-dark bg-surface-dark/70 p-3">
                        <div className="mb-2 text-[11px] font-medium text-text-muted">展示顺序</div>
                        <div className="flex flex-col gap-2">
                          {draft.jsonFields
                            .filter((field) => field.enabled)
                            .map((field, displayIndex, enabledFields) => (
                              <div
                                key={field.id}
                                className="flex items-center gap-2 rounded-md border border-border-dark bg-bg-dark px-2 py-2"
                              >
                                <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-white/8 px-1 text-[10px] text-text-muted">
                                  {displayIndex + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-text-dark">{field.label}</div>
                                  <div className="truncate text-[10px] text-text-muted">{field.path}</div>
                                </div>
                                <button
                                  type="button"
                                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-dark text-text-muted transition-colors hover:bg-surface-dark hover:text-text-dark disabled:opacity-35"
                                  title="上移"
                                  disabled={displayIndex === 0}
                                  onClick={() => setDraft((previous) => previous ? ({
                                    ...previous,
                                    jsonFields: moveJsonField(previous.jsonFields, field.id, -1),
                                  }) : previous)}
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-dark text-text-muted transition-colors hover:bg-surface-dark hover:text-text-dark disabled:opacity-35"
                                  title="下移"
                                  disabled={displayIndex === enabledFields.length - 1}
                                  onClick={() => setDraft((previous) => previous ? ({
                                    ...previous,
                                    jsonFields: moveJsonField(previous.jsonFields, field.id, 1),
                                  }) : previous)}
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                        </div>
                      </div>
                    ) : null}
                    {jsonExampleState.options.length > 0 ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {jsonExampleState.options.map((option) => {
                          const existing = draft.jsonFields.find((field) => field.path === option.path);
                          const checked = existing?.enabled ?? false;
                          return (
                            <div
                              key={option.path}
                              className="rounded-lg border border-border-dark bg-surface-dark px-3 py-2"
                            >
                              <label className="flex items-start gap-2">
                                <UiCheckbox
                                  checked={checked}
                                  onCheckedChange={(nextChecked) => setDraft((previous) => {
                                    if (!previous) {
                                      return previous;
                                    }
                                    const nextFields = previous.jsonFields.filter((field) => field.path !== option.path);
                                    if (nextChecked) {
                                      nextFields.push({
                                        id: existing?.id ?? `draft-json-field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                                        path: option.path,
                                        label: existing?.label ?? option.label,
                                        enabled: true,
                                      });
                                    }
                                    return {
                                      ...previous,
                                      jsonFields: nextFields,
                                    };
                                  })}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-text-dark">{option.path}</div>
                                  {checked ? (
                                    <UiInput
                                      value={existing?.label ?? option.label}
                                      onChange={(event) => setDraft((previous) => previous ? ({
                                        ...previous,
                                        jsonFields: previous.jsonFields.map((field) => field.path === option.path
                                          ? { ...field, label: event.target.value, enabled: true }
                                          : field),
                                      }) : previous)}
                                      className="mt-2 h-8 text-xs"
                                    />
                                  ) : null}
                                </div>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border-dark bg-surface-dark/50 p-4 text-sm text-text-muted">
                        填入可解析的 JSON 示例后，这里会列出可勾选字段。
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-border-dark px-6 py-4">
              <div className="mr-auto min-h-5 text-xs text-red-300">{error}</div>
              {saved ? <div className="text-xs text-emerald-300">已保存</div> : null}
              <UiButton type="button" variant="ghost" size="sm" onClick={handleDelete}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                删除 Agent
              </UiButton>
              <UiButton type="button" variant="primary" size="sm" onClick={saveDraft}>
                保存 Agent
              </UiButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
