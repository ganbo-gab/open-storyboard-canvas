import {
  modelCapabilities,
  profileCapabilities,
  type ChannelCapability,
} from "./channelCapabilities";
import type { ChannelRecord } from "../store/channelStore";
import type { ModelSpec } from "../domain/profile";

export interface ChannelModelListing {
  channel: ChannelRecord;
  model: ModelSpec;
  capabilities: ChannelCapability[];
}
export interface ChannelBrowseFilter {
  query: string;
  capability: ChannelCapability | "all";
  channelId?: string;
}
export function channelModelListings(
  channels: readonly ChannelRecord[],
  filter: ChannelBrowseFilter,
): ChannelModelListing[] {
  const query = filter.query.trim().toLowerCase();
  return channels.flatMap((channel) =>
    channel.profile.models.flatMap((model) => {
      const capabilities = modelCapabilities(model);
      if (filter.channelId && channel.profile.id !== filter.channelId)
        return [];
      if (
        filter.capability !== "all" &&
        !capabilities.includes(filter.capability)
      )
        return [];
      if (
        query &&
        ![
          channel.profile.name,
          channel.profile.baseUrl,
          model.id,
          model.label ?? "",
        ].some((value) => value.toLowerCase().includes(query))
      )
        return [];
      return [{ channel, model, capabilities }];
    }),
  );
}
export function channelConnectionShape(
  channel: ChannelRecord,
): "single" | "multiple" | "mixed" {
  return channel.profile.models.length === 1
    ? "single"
    : profileCapabilities(channel.profile).length > 1
      ? "mixed"
      : "multiple";
}
