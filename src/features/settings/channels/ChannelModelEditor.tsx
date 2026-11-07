import { initializeModelCapabilities } from '@/features/channels/application/modelCapabilityPresets';
import { ModelCapabilitiesFields } from './ModelCapabilitiesFields';
import { useState } from "react";
import { ChevronDown, CopyPlus, Download, Plus, Search, SlidersHorizontal, Undo2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  UiBadge,
  UiButton,
  UiCheckbox,
  UiChipButton,
  UiField,
  UiIconButton,
  UiInput,
  UiModal,
  UiSelect,
} from "@/components/ui";
import {
  operationKinds,
  type ChannelProfileV2,
} from "@/features/channels/domain/profile";
import {
  channelCapabilities,
  cloneModelAs,
  modelCapabilities,
  modelCapabilityCounts,
  type ChannelCapability,
} from "@/features/channels/application/channelCapabilities";
import { CapabilityBadges } from "@/features/channels/ui/CapabilityBadge";
import { builtInPresets } from "@/features/channels/presets";
import {
  copyModelConnection,
  modelConnectionHeadersCompatible,
} from "@/features/channels/application/modelConnection";
import { ModelModesEditor } from "./ModelModesEditor";
import { BatchModelParametersDialog } from './BatchModelParametersDialog';
import { listBatchModelParameterContexts } from '@/features/channels/application/batchModelParameters';

interface Props {
  profile: ChannelProfileV2;
  onChange(profile: ChannelProfileV2): void;
  focusedModelId?: string;
  discoveredModels: readonly string[];
}
/** Models remain declarations owned by their channel; adding an ID never guesses its capability. */
export function ChannelModelEditor({
  profile,
  onChange,
  focusedModelId,
  discoveredModels,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<ChannelCapability | "all">(
    "all",
  );
  const [expanded, setExpanded] = useState<number | null>(() =>
    focusedModelId
      ? profile.models.findIndex((model) => model.id === focusedModelId)
      : profile.models.length === 1
        ? 0
        : null,
  );
  const [add, setAdd] = useState<"manual" | "discovery" | null>(null);
  const [templateIndex, setTemplateIndex] = useState(0);
  const [sourceKind, setSourceKind] = useState<"channel" | "template">(
    "channel",
  );
  const templates = builtInPresets.flatMap((entry) =>
    entry.models.map((model) => ({ profile: entry, model })),
  );
  const [newId, setNewId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [discoverySearch, setDiscoverySearch] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [lastBatch, setLastBatch] = useState<{ before: ChannelProfileV2; after: ChannelProfileV2 } | null>(null);
  const counts = modelCapabilityCounts(profile.models);
  const visible = profile.models
    .map((model, index) => ({ model, index }))
    .filter(
      ({ model }) =>
        (capability === "all" ||
          modelCapabilities(model).includes(capability)) &&
        `${model.id} ${model.label ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );
  const available = discoveredModels.filter(
    (id) => !profile.models.some((model) => model.id === id),
  );
  const ids = add === "manual" ? [newId.trim()].filter(Boolean) : selected;
  const duplicate = ids.some((id) =>
    profile.models.some((model) => model.id === id),
  );
  const template = templates[templateIndex];
  const source =
    sourceKind === "channel" ? profile.models[templateIndex] : template?.model;
  const openAdd = (mode: "manual" | "discovery") => {
    setAdd(mode);
    setSelected([]);
    setNewId("");
    setDiscoverySearch("");
    setTemplateIndex(0);
    setSourceKind("channel");
  };
  const compatible =
    sourceKind === "channel" ||
    Boolean(
      template && modelConnectionHeadersCompatible(profile, template.profile),
    );
  const insert = () => {
    if (!source || !ids.length || duplicate || !compatible) return;
    onChange({
      ...profile,
      models: [
        ...profile.models,
        ...ids.map((id) =>
          initializeModelCapabilities(sourceKind === "template" && template
            ? copyModelConnection(template.profile, source, id, profile)
            : cloneModelAs(source, id)),
        ),
      ],
    });
    setCapability("all");
    setQuery("");
    setExpanded(profile.models.length);
    setAdd(null);
  };
  return (
    <section className="channel-model-editor">
      <header>
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="text-sm font-semibold">
            {t("ui.channels.manage.title")}{" "}
            <span className="text-text-subtle">{profile.models.length}</span>
          </h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            {t("ui.channels.manage.hint")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
        <UiButton size="sm" icon={<SlidersHorizontal />} disabled={listBatchModelParameterContexts(profile).length < 2} onClick={() => setBatchOpen(true)}>{t('ui.channels.batch.title')}</UiButton>
        <UiButton
          size="sm"
          icon={<Plus />}
          onClick={() => openAdd("manual")}
          disabled={!profile.models.length}
        >
          {t("rework.channels.addModel")}
        </UiButton>
        </div>
      </header>
      {lastBatch && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 text-xs">
        <span className="min-w-0 flex-1">{t('ui.channels.batch.applied')}</span>
        <UiButton size="sm" variant="ghost" icon={<Undo2 />} disabled={profile !== lastBatch.after} title={profile !== lastBatch.after ? t('ui.channels.batch.undoChanged') : undefined} onClick={() => { if (profile === lastBatch.after) { onChange(lastBatch.before); setLastBatch(null); } }}>{t('ui.channels.batch.undo')}</UiButton>
      </div>}
      {profile.models.length > 1 && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <UiChipButton
              active={capability === "all"}
              onClick={() => setCapability("all")}
            >
              {t("ui.channels.catalog.all")}
            </UiChipButton>
            {channelCapabilities
              .filter((kind) => counts[kind] > 0)
              .map((kind) => (
                <UiChipButton
                  key={kind}
                  active={capability === kind}
                  onClick={() => setCapability(kind)}
                >
                  {t(`ui.channels.cap.${kind}.short`)} {counts[kind]}
                </UiChipButton>
              ))}
          </div>
          <label className="channel-market__search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("ui.channels.manage.search")}
              aria-label={t("ui.channels.manage.search")}
            />
          </label>
        </>
      )}
      {discoveredModels.length > 0 && (
        <UiButton
          size="sm"
          variant="secondary"
          icon={<Download />}
          onClick={() => openAdd("discovery")}
          disabled={!available.length}
        >
          {t("ui.channels.manage.importModels", { count: available.length })}
        </UiButton>
      )}
      <div className="space-y-2">
        {visible.map(({ model, index }) => (
          <article key={index} className="channel-model-editor__item">
            <header>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                aria-expanded={expanded === index}
                onClick={() => setExpanded(expanded === index ? null : index)}
              >
                <span className="block truncate text-sm font-medium">
                  {model.label || model.id}
                </span>
                <span className="mt-1 block truncate font-mono text-xs text-text-subtle">
                  {model.id}
                </span>
              </button>
              <CapabilityBadges capabilities={modelCapabilities(model)} />
              <UiIconButton
                size="sm"
                title={t("ui.channels.manage.edit")}
                aria-label={`${t("ui.channels.manage.edit")} ${model.id}`}
                aria-expanded={expanded === index}
                onClick={() => setExpanded(expanded === index ? null : index)}
              >
                <ChevronDown
                  className={expanded === index ? "rotate-180" : ""}
                />
              </UiIconButton>
            </header>
            {expanded === index && (
              <div className="space-y-4 border-t border-line p-3">
                <UiField
                  label={t("ui.channels.manage.modelId")}
                  hint={t("ui.channels.manage.modelIdHint")}
                >
                  <UiInput
                    aria-label={t("ui.channels.manage.modelId")}
                    value={model.id}
                    onChange={(event) =>
                      onChange({
                        ...profile,
                        models: profile.models.map((entry, i) =>
                          i === index
                            ? { ...entry, id: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                </UiField>
                <UiField label={t("ui.channels.manage.label")}>
                  <UiInput
                    aria-label={t("ui.channels.manage.label")}
                    value={model.label ?? ""}
                    onChange={(event) =>
                      onChange({
                        ...profile,
                        models: profile.models.map((entry, i) =>
                          i === index
                            ? { ...entry, label: event.target.value }
                            : entry,
                        ),
                      })
                    }
                  />
                </UiField>
                {!model.modes?.length && (
                  <UiField
                    label={t("ui.channels.manage.operations")}
                    hint={t("ui.channels.manage.operationHint")}
                  >
                    <div className="flex flex-wrap gap-2">
                      {operationKinds
                        .filter(
                          (operation) =>
                            operation !== "models.list" &&
                            profile.operations[operation],
                        )
                        .map((operation) => (
                          <UiChipButton
                            key={operation}
                            active={model.operations.includes(operation)}
                            onClick={() => {
                              const operations = model.operations.includes(
                                operation,
                              )
                                ? model.operations.filter(
                                    (entry) => entry !== operation,
                                  )
                                : [...model.operations, operation];
                              if (operations.length)
                                onChange({
                                  ...profile,
                                  models: profile.models.map((entry, i) =>
                                    i === index
                                      ? { ...entry, operations }
                                      : entry,
                                  ),
                                });
                            }}
                          >
                            {t(
                              `ui.channels.operation.${{ chat: "chat", "image.generate": "imageGenerate", "image.edit": "imageEdit", "video.generate": "videoGenerate", "audio.generate": "audioGenerate", "model.generate": "modelGenerate", "models.list": "modelsList" }[operation]}`,
                            )}
                          </UiChipButton>
                        ))}
                    </div>
                  </UiField>
                )}
                {model.operations.includes('chat') && <ModelCapabilitiesFields model={model} onChange={(next) => onChange({ ...profile, models: profile.models.map((item, i) => i === index ? next : item) })} />}
                <ModelModesEditor
                  model={model}
                  onChange={(next) =>
                    onChange({
                      ...profile,
                      models: profile.models.map((entry, i) =>
                        i === index ? next : entry,
                      ),
                    })
                  }
                />
                <div className="flex items-center justify-between gap-2">
                  <UiButton
                    size="sm"
                    variant="ghost"
                    icon={<CopyPlus />}
                    onClick={() => {
                      openAdd("manual");
                      setTemplateIndex(index);
                    }}
                  >
                    {t("ui.channels.manage.duplicate")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    variant="ghost"
                    icon={<X />}
                    disabled={profile.models.length === 1}
                    title={
                      profile.models.length === 1
                        ? t("ui.channels.manage.minimum")
                        : undefined
                    }
                    className="text-danger"
                    onClick={() => {
                      onChange({
                        ...profile,
                        models: profile.models.filter((_, i) => i !== index),
                      });
                      setExpanded(null);
                    }}
                  >
                    {t("ui.channels.manage.remove")}
                  </UiButton>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {!visible.length && (
        <p className="py-4 text-center text-xs text-text-muted">
          {t("rework.noMatches")}
        </p>
      )}
      {batchOpen && <BatchModelParametersDialog profile={profile} initialModelId={expanded === null ? undefined : profile.models[expanded]?.id}
        onClose={() => setBatchOpen(false)} onApply={next => { setLastBatch({ before: profile, after: next }); onChange(next); setBatchOpen(false); }} />}
      <UiModal
        isOpen={Boolean(add)}
        title={t(
          add === "discovery"
            ? "ui.channels.manage.importTitle"
            : "rework.channels.addModel",
        )}
        onClose={() => setAdd(null)}
        widthClassName="w-[600px]"

        footer={
          <UiButton
            variant="primary"
            disabled={!source || !ids.length || duplicate || !compatible}
            onClick={insert}
          >
            {t("ui.channels.manage.addSelected", { count: ids.length })}
          </UiButton>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-2">
            <UiChipButton
              active={sourceKind === "channel"}
              onClick={() => {
                setSourceKind("channel");
                setTemplateIndex(0);
              }}
            >
              {t("ui.channels.manage.fromChannel")}
            </UiChipButton>
            <UiChipButton
              active={sourceKind === "template"}
              onClick={() => {
                setSourceKind("template");
                setTemplateIndex(0);
              }}
            >
              {t("ui.channels.manage.fromTemplate")}
            </UiChipButton>
          </div>
          <UiField
            label={t("ui.channels.manage.copyFrom")}
            hint={t("ui.channels.manage.copyHint")}
          >
            <UiSelect
              value={String(templateIndex)}
              onChange={(event) => setTemplateIndex(Number(event.target.value))}
            >
              {(sourceKind === "channel"
                ? profile.models.map((model) => ({ model, profile }))
                : templates
              ).map(({ model, profile: origin }, index) => (
                <option key={index} value={index}>
                  {sourceKind === "template" ? `${origin.name} · ` : ""}
                  {model.label || model.id} ·{" "}
                  {modelCapabilities(model)
                    .map((kind) => t(`ui.channels.cap.${kind}.short`))
                    .join("/")}
                </option>
              ))}
            </UiSelect>
          </UiField>
          {sourceKind === "template" && (
            <p className="rounded-lg bg-warning/10 p-3 text-xs leading-6 text-text-muted">
              {t("ui.channels.manage.templateHint")}
            </p>
          )}
          {!compatible && (
            <p
              role="alert"
              className="rounded-lg bg-warning/10 p-3 text-xs leading-6 text-warning"
            >
              {t("ui.channels.manage.headersIncompatible")}
            </p>
          )}
          {source && (
            <CapabilityBadges capabilities={modelCapabilities(source)} />
          )}
          {add === "manual" ? (
            <UiField
              label={t("ui.channels.manage.modelId")}
              hint={
                duplicate
                  ? t("ui.channels.manage.duplicateId")
                  : t("ui.channels.manage.modelIdHint")
              }
            >
              <UiInput
                aria-label={t("ui.channels.manage.modelId")}
                autoFocus
                value={newId}
                onChange={(event) => setNewId(event.target.value)}
              />
            </UiField>
          ) : (
            <>
              <p className="text-xs leading-6 text-text-muted">
                {t("ui.channels.manage.discoveryHint")}
              </p>
              <label className="channel-market__search">
                <Search size={14} />
                <input
                  value={discoverySearch}
                  onChange={(event) => setDiscoverySearch(event.target.value)}
                  placeholder={t("ui.channels.manage.search")}
                />
              </label>
              <div className="ui-scrollbar max-h-64 space-y-2 overflow-y-auto">
                {available
                  .filter((id) =>
                    id.toLowerCase().includes(discoverySearch.toLowerCase()),
                  )
                  .map((id) => (
                    <label key={id} className="flex items-center gap-2 text-sm">
                      <UiCheckbox
                        aria-label={id}
                        checked={selected.includes(id)}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, id]
                              : current.filter((entry) => entry !== id),
                          )
                        }
                      />
                      <span>{id}</span>
                    </label>
                  ))}
              </div>
              <UiBadge>
                {t("ui.channels.manage.selected", { count: selected.length })}
              </UiBadge>
            </>
          )}
        </div>
      </UiModal>
    </section>
  );
}
