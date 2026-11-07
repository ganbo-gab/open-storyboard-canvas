import { useMemo, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  ChevronRight,
  FlaskConical,
  LayoutGrid,
  List,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  UiBadge,
  UiButton,
  UiChipButton,
  UiIconButton,
  UiModal,
  UiSelect,
  UiTabs,
} from "@/components/ui";
import {
  channelCapabilities,
  modelCapabilityCounts,
  profileCapabilities,
  type ChannelCapability,
} from "@/features/channels/application/channelCapabilities";
import {
  channelConnectionShape,
  channelModelListings,
} from "@/features/channels/application/channelMarketplace";
import {
  credentialConfigured,
  subscribeChannelCredentials,
  type ChannelRecord,
} from "@/features/channels/store/channelStore";
import { baseUrlNeedsReplacement } from "@/features/channels/presets/templateCatalog";
import type { ModelSpec } from "@/features/channels/domain/profile";
import { CapabilityBadges } from "@/features/channels/ui/CapabilityBadge";
import { ModelSpecCard } from "@/features/channels/ui/ModelSpecCard";
import {
  CAPABILITY_ICON,
  CAPABILITY_TINT,
} from "@/features/channels/ui/capabilityStyles";
import { useChannelUiStore } from "@/features/channels/application/channelUiStore";
import { ChannelKeyBadge, ChannelTestBadge } from "./ChannelStatus";

interface Props {
  channels: readonly ChannelRecord[];
  onAdd(): void;
  onEdit(channel: ChannelRecord, modelId?: string): void;
  onDelete(id: string): void;
  onTry(channel: ChannelRecord, model: ModelSpec): void;
  onUse(
    channel: ChannelRecord,
    model: ModelSpec,
    capability: Exclude<ChannelCapability, "model">,
  ): void;
}

/** Browses saved channels and models as two views over the same declarations. */
export function ChannelMarketplace({
  channels,
  onAdd,
  onEdit,
  onDelete,
  onTry,
  onUse,
}: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<"channels" | "models">("channels");
  const [layout, setLayout] = useState<"grid" | "table">("grid");
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<ChannelCapability | "all">(
    "all",
  );
  const [status, setStatus] = useState("all");
  const [channelId, setChannelId] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  const [modelDetail, setModelDetail] = useState<{
    channelId: string;
    modelId: string;
  } | null>(null);
  const tests = useChannelUiStore((state) => state.tests);
  const credentialSnapshot = () =>
    channels
      .map((entry) => (credentialConfigured(entry.profile.id) ? "1" : "0"))
      .join("");
  useSyncExternalStore(
    subscribeChannelCredentials,
    credentialSnapshot,
    credentialSnapshot,
  );
  const ready = (channel: ChannelRecord) =>
    (channel.profile.auth.type === "none" ||
      credentialConfigured(channel.profile.id)) &&
    !baseUrlNeedsReplacement(channel.profile.baseUrl) &&
    channel.profile.models.length > 0;
  const eligible = channels.filter(
    (channel) =>
      status === "all" ||
      (status === "ready"
        ? ready(channel)
        : status === "missing"
          ? !ready(channel)
          : tests[channel.profile.id]?.result === "failed"),
  );
  const listings = useMemo(
    () =>
      channelModelListings(eligible, {
        query,
        capability,
        channelId: detail ?? channelId,
      }),
    [eligible, query, capability, channelId, detail],
  );
  const visibleChannels = eligible.filter(
    (channel) =>
      (!channelId || channel.profile.id === channelId) &&
      (listings.some(
        (entry) => entry.channel.profile.id === channel.profile.id,
      ) ||
        (!channel.profile.models.length &&
          capability === "all" &&
          channel.profile.name.toLowerCase().includes(query.toLowerCase()))),
  );
  const current = channels.find((channel) => channel.profile.id === detail);
  const selectedChannel = channels.find(
    (channel) => channel.profile.id === modelDetail?.channelId,
  );
  const selectedModel = selectedChannel?.profile.models.find(
    (model) => model.id === modelDetail?.modelId,
  );
  const totals = modelCapabilityCounts(
    current
      ? current.profile.models
      : channels.flatMap((channel) => channel.profile.models),
  );
  const reset = () => {
    setQuery("");
    setCapability("all");
    setStatus("all");
    setChannelId("");
  };
  const openChannel = (id: string) => {
    reset();
    setDetail(id);
  };
  const source = (channel: ChannelRecord) => {
    try {
      return new URL(channel.profile.baseUrl).host;
    } catch {
      return channel.profile.baseUrl;
    }
  };
  const modelActions = (channel: ChannelRecord, model: ModelSpec) => (
    <>
      <UiButton
        size="sm"
        variant="secondary"
        icon={<Settings2 />}
        onClick={() => {
          setModelDetail(null);
          onEdit(channel, model.id);
        }}
      >
        {t("ui.channels.market.configureModel")}
      </UiButton>
      <UiButton
        size="sm"
        icon={<FlaskConical />}
        onClick={() => {
          setModelDetail(null);
          onTry(channel, model);
        }}
      >
        {t("ui.channels.market.tryModel")}
      </UiButton>
    </>
  );
  return (
    <div className="channel-market">
      {current ? (
        <header className="channel-market__detail-header">
          <UiButton
            variant="ghost"
            icon={<ArrowLeft />}
            onClick={() => {
              setDetail(null);
              reset();
            }}
          >
            {t("ui.channels.market.back")}
          </UiButton>
          <div className="flex items-start gap-4">
            <span className="channel-market__mark">
              <Plug />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold">{current.profile.name}</h2>
              <p className="mt-1 break-all text-xs text-text-subtle">
                {current.profile.baseUrl}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <CapabilityBadges
                  capabilities={profileCapabilities(current.profile)}
                />
                <ChannelKeyBadge
                  ready={credentialConfigured(current.profile.id)}
                  required={current.profile.auth.type !== "none"}
                />
                <ChannelTestBadge channelId={current.profile.id} />
              </div>
            </div>
            <UiButton icon={<Pencil />} onClick={() => onEdit(current)}>
              {t("ui.channels.market.configureChannel")}
            </UiButton>
          </div>
          <p className="text-sm text-text-muted">
            {t(
              `ui.channels.market.shapeHint.${channelConnectionShape(current)}`,
              {
                count: current.profile.models.length,
                categories: profileCapabilities(current.profile).length,
              },
            )}
          </p>
        </header>
      ) : (
        <>
          <header className="channel-market__header">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                {t("ui.channels.market.title")}
              </h2>
              <p className="mt-2 text-sm text-text-muted">
                {t("ui.channels.market.subtitle", {
                  channels: channels.length,
                  models: channels.reduce(
                    (sum, channel) => sum + channel.profile.models.length,
                    0,
                  ),
                })}
              </p>
            </div>
            <UiButton variant="primary" icon={<Plus />} onClick={onAdd}>
              {t("ui.channels.market.add")}
            </UiButton>
          </header>
          <UiTabs
            value={view}
            onChange={setView}
            aria-label={t("ui.channels.market.view")}
            options={[
              {
                value: "channels",
                label: t("ui.channels.market.channels"),
                icon: <Plug />,
              },
              {
                value: "models",
                label: t("ui.channels.market.models"),
                icon: <Boxes />,
              },
            ]}
          />
        </>
      )}
      <div className="channel-market__filters">
        <div className="flex flex-wrap gap-2">
          <UiChipButton
            active={capability === "all"}
            onClick={() => setCapability("all")}
          >
            {t("ui.channels.catalog.all")}
          </UiChipButton>
          {channelCapabilities.map((kind) => (
            <UiChipButton
              key={kind}
              active={capability === kind}
              onClick={() => setCapability(kind)}
            >
              {t(`ui.channels.cap.${kind}.short`)}
              <span className="ml-1.5 text-text-subtle">{totals[kind]}</span>
            </UiChipButton>
          ))}
        </div>
        <div className="channel-market__search-row">
          <label className="channel-market__search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("ui.channels.market.search")}
              aria-label={t("ui.channels.market.search")}
            />
          </label>
          {!current && view === "models" && (
            <UiSelect
              aria-label={t("ui.channels.market.filterChannel")}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">{t("ui.channels.market.allChannels")}</option>
              {channels.map((channel) => (
                <option value={channel.profile.id} key={channel.profile.id}>
                  {channel.profile.name}
                </option>
              ))}
            </UiSelect>
          )}
          <UiSelect
            aria-label={t("ui.channels.market.filterStatus")}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {["all", "ready", "missing", "failed"].map((value) => (
              <option key={value} value={value}>
                {t(`ui.channels.market.status.${value}`)}
              </option>
            ))}
          </UiSelect>
          <div className="flex rounded-lg border border-line p-0.5">
            <UiIconButton
              aria-label={t("ui.channels.market.grid")}
              title={t("ui.channels.market.grid")}
              data-active={layout === "grid" || undefined}
              onClick={() => setLayout("grid")}
            >
              <LayoutGrid />
            </UiIconButton>
            <UiIconButton
              aria-label={t("ui.channels.market.table")}
              title={t("ui.channels.market.table")}
              data-active={layout === "table" || undefined}
              onClick={() => setLayout("table")}
            >
              <List />
            </UiIconButton>
          </div>
        </div>
      </div>
      {!current && view === "channels" ? (
        <div
          className={
            layout === "grid" ? "channel-market__grid" : "channel-market__rows"
          }
        >
          {visibleChannels.map((channel) => (
            <article
              className="channel-market__channel"
              data-layout={layout}
              key={channel.profile.id}
            >
              <button
                type="button"
                className="channel-market__channel-main"
                onClick={() => openChannel(channel.profile.id)}
              >
                <span className="channel-market__mark">
                  <Plug />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {channel.profile.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-subtle">
                    {source(channel)}
                  </span>
                </span>
                <ChevronRight size={16} className="text-text-subtle" />
              </button>
              <div className="flex flex-wrap gap-1.5">
                <UiBadge>
                  {t(
                    `ui.channels.market.shape.${channelConnectionShape(channel)}`,
                  )}
                </UiBadge>
                <ChannelKeyBadge
                  ready={credentialConfigured(channel.profile.id)}
                  required={channel.profile.auth.type !== "none"}
                />
                <ChannelTestBadge channelId={channel.profile.id} />
              </div>
              <CapabilityBadges
                capabilities={profileCapabilities(channel.profile)}
              />
              <p className="channel-market__model-preview">
                {channel.profile.models
                  .slice(0, 3)
                  .map((model) => model.label || model.id)
                  .join(" · ")}
                {channel.profile.models.length > 3 ? " …" : ""}
              </p>
              <footer>
                <button
                  type="button"
                  className="text-xs text-accent"
                  onClick={() => openChannel(channel.profile.id)}
                >
                  {t("ui.channels.market.browseModels", {
                    count: channel.profile.models.length,
                  })}
                  <ArrowRight size={13} />
                </button>
                <UiIconButton
                  size="sm"
                  title={t("rework.delete")}
                  aria-label={`${t("rework.delete")} ${channel.profile.name}`}
                  onClick={() => onDelete(channel.profile.id)}
                >
                  <Trash2 />
                </UiIconButton>
                <UiButton
                  size="sm"
                  variant="secondary"
                  icon={<Pencil />}
                  onClick={() => onEdit(channel)}
                >
                  {t("ui.channels.market.configure")}
                </UiButton>
              </footer>
            </article>
          ))}
          {!visibleChannels.length && (
            <Empty empty={!channels.length} onReset={reset} onAdd={onAdd} />
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-text-subtle">
            {t("ui.channels.market.showingModels", { count: listings.length })}
          </p>
          {layout === "table" && listings.length ? (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="channel-market__table">
                <thead>
                  <tr>
                    {["model", "channel", "capability", "availability"].map(
                      (key) => (
                        <th key={key}>
                          {t(`ui.channels.market.columns.${key}`)}
                        </th>
                      ),
                    )}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {listings.map(({ channel, model, capabilities }) => (
                    <tr key={`${channel.profile.id}:${model.id}`}>
                      <td>
                        <button
                          type="button"
                          onClick={() =>
                            setModelDetail({
                              channelId: channel.profile.id,
                              modelId: model.id,
                            })
                          }
                        >
                          <strong>{model.label || model.id}</strong>
                          <small>{model.id}</small>
                        </button>
                      </td>
                      <td>{channel.profile.name}</td>
                      <td>
                        <CapabilityBadges capabilities={capabilities} />
                      </td>
                      <td>
                        <UiBadge tone={ready(channel) ? "success" : "warning"}>
                          {t(
                            `ui.channels.market.status.${ready(channel) ? "ready" : "missing"}`,
                          )}
                        </UiBadge>
                      </td>
                      <td>
                        <UiButton
                          size="sm"
                          onClick={() =>
                            setModelDetail({
                              channelId: channel.profile.id,
                              modelId: model.id,
                            })
                          }
                        >
                          {t("ui.channels.market.details")}
                        </UiButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="channel-market__grid">
              {listings.map(({ channel, model, capabilities }) => {
                const kind = capabilities[0] ?? "chat";
                const Icon = CAPABILITY_ICON[kind];
                return (
                  <article
                    className="channel-market__model"
                    key={`${channel.profile.id}:${model.id}`}
                  >
                    <button
                      type="button"
                      className="channel-market__model-main"
                      onClick={() =>
                        setModelDetail({
                          channelId: channel.profile.id,
                          modelId: model.id,
                        })
                      }
                    >
                      <span
                        className={`channel-market__mark ${CAPABILITY_TINT[kind]}`}
                      >
                        <Icon />
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate font-semibold">
                          {model.label || model.id}
                        </strong>
                        <small className="mt-1 block truncate text-xs text-text-subtle">
                          {model.id}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="text-left text-xs text-text-muted hover:text-accent"
                      onClick={() => openChannel(channel.profile.id)}
                    >
                      {channel.profile.name}
                    </button>
                    <CapabilityBadges capabilities={capabilities} />
                    <p className="text-xs text-text-muted">
                      {model.modes?.map((mode) => mode.label).join(" · ") ||
                        t("ui.channels.market.defaultMode")}
                    </p>
                    <footer>
                      <UiBadge tone={ready(channel) ? "success" : "warning"}>
                        {t(
                          `ui.channels.market.status.${ready(channel) ? "ready" : "missing"}`,
                        )}
                      </UiBadge>
                      <UiButton
                        size="sm"
                        onClick={() =>
                          setModelDetail({
                            channelId: channel.profile.id,
                            modelId: model.id,
                          })
                        }
                      >
                        {t("ui.channels.market.details")}
                        <ArrowRight size={14} />
                      </UiButton>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
          {!listings.length && (
            <Empty empty={!channels.length} onReset={reset} onAdd={onAdd} />
          )}
        </>
      )}
      <p className="channel-market__footnote">
        {t("ui.channels.market.testHint")}
      </p>
      {selectedChannel && selectedModel && (
        <UiModal
          isOpen
          onClose={() => setModelDetail(null)}
          title={selectedModel.label || selectedModel.id}
          widthClassName="w-[680px]"

          footer={modelActions(selectedChannel, selectedModel)}
        >
          <p className="mb-4 text-sm text-text-muted">
            {selectedChannel.profile.name}
          </p>
          <ModelSpecCard model={selectedModel} showCapabilities />
          <div className="mt-5 flex flex-wrap gap-2">
            {channelModelListings([selectedChannel], {
              query: "",
              capability: "all",
            })
              .find((entry) => entry.model.id === selectedModel.id)
              ?.capabilities.map((kind) =>
                kind === "model" ? (
                  <p className="text-xs text-text-muted" key={kind}>
                    {t("ui.channels.market.useInStage")}
                  </p>
                ) : (
                  <UiButton
                    key={kind}
                    variant="primary"
                    disabled={!ready(selectedChannel)}
                    onClick={() => {
                      setModelDetail(null);
                      onUse(selectedChannel, selectedModel, kind);
                    }}
                  >
                    {t("ui.channels.market.create", {
                      kind: t(`ui.channels.cap.${kind}.short`),
                    })}
                    <ArrowRight size={14} />
                  </UiButton>
                ),
              )}
          </div>
        </UiModal>
      )}
    </div>
  );
}
function Empty({
  empty,
  onReset,
  onAdd,
}: {
  empty: boolean;
  onReset(): void;
  onAdd(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="channel-market__empty">
      <Plug size={28} />
      <h3>{t(`ui.channels.market.${empty ? "emptyTitle" : "noMatches"}`)}</h3>
      <p>{t(`ui.channels.market.${empty ? "emptyHint" : "filterHint"}`)}</p>
      <UiButton variant="secondary" onClick={empty ? onAdd : onReset}>
        {t(`ui.channels.market.${empty ? "add" : "reset"}`)}
      </UiButton>
    </div>
  );
}
