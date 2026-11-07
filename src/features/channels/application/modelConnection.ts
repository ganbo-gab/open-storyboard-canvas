import { t } from "i18next";
import type { ChannelProfileV2, ModelSpec, ModeSpec } from "../domain/profile";
import { listModelModes } from "./modelModes";

/** Bind the selected API contract to the added model without replacing other channel operations. */
export function copyModelConnection(
  profile: ChannelProfileV2,
  model: ModelSpec,
  id: string,
  target: ChannelProfileV2,
): ModelSpec {
  if (!modelConnectionHeadersCompatible(target, profile))
    throw new Error("Model contract requires incompatible channel headers");
  const copied = structuredClone(model);
  const modes: ModeSpec[] = copied.modes?.length
    ? copied.modes
    : copied.operations
        .filter((operation) => operation !== "models.list")
        .map((operation, index) => ({
          id: `${operation.replace(".", "-")}-${index + 1}`,
          label:
            t(
              `ui.channels.operation.${{ chat: "chat", "image.generate": "imageGenerate", "image.edit": "imageEdit", "video.generate": "videoGenerate", "audio.generate": "audioGenerate", "model.generate": "modelGenerate", "models.list": "modelsList" }[operation]}`,
              { defaultValue: operation },
            ) || operation,
          operation,
          slots: listModelModes(copied)[0]?.slots ?? [],
        }));
  return {
    ...copied,
    id,
    label: id,
    modes: modes.map((mode) => ({
      ...mode,
      endpoint: structuredClone(
        mode.endpoint ?? profile.operations[mode.operation],
      ),
    })),
  };
}

/** Profile-level transport headers cannot be silently lost or applied to sibling models. */
export function modelConnectionHeadersCompatible(
  target: ChannelProfileV2,
  source: ChannelProfileV2,
): boolean {
  const targetHeaders = Object.fromEntries(
    Object.entries(target.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return Object.entries(source.headers ?? {}).every(
    ([key, value]) => targetHeaders[key.toLowerCase()] === value,
  );
}
