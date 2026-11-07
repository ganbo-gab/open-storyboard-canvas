import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { ParamSpec } from "@/features/channels/domain/profile";
import { UiField, UiInput, UiSegmented, UiSelect } from "@/components/ui/primitives";
import { sameParameterValue, parameterDisplayName, parameterIsAdvanced } from './parameterPresentation';
import { PixelSizeControl } from './PixelSizeControl';
import { pixelSizeChoices } from './sizeParameterPresentation';

type Props = {
  params: ParamSpec[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
};

/** Column count follows the container (workbench row vs. node popover), not the viewport. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3";

/** Renders exactly the selected mode's declared parameters: basic ones inline, advanced ones folded. */
export function DeclaredParameters({ params, values, onChange }: Props) {
  const { t } = useTranslation();
  if (!params.length) return null;
  const basic = params.filter((param) => param.display !== 'hidden' && !parameterIsAdvanced(param));
  const advanced = params.filter((param) => param.display !== 'hidden' && parameterIsAdvanced(param));
  const field = (param: ParamSpec) => {
    const value = values[param.key] ?? param.default;
    const change = (next: unknown) => {
      const updated = { ...values };
      if (next === undefined) delete updated[param.key];
      else updated[param.key] = next;
      onChange(updated);
    };
    const label = `${parameterDisplayName(param)}${param.required ? " *" : ""}`;
    return (
      <UiField key={param.key} label={label} hint={param.description} className="min-w-0">
        {param.sizeDisplay === 'ratio-resolution' && pixelSizeChoices(param).length > 0 ? (
          <PixelSizeControl param={param} value={value} onChange={change} />
        ) : param.type === "enum" ? (
          <UiSelect
            aria-label={param.label}
            value={String(
              param.options?.findIndex(
                (option) => sameParameterValue(option.value, value),
              ) ?? -1,
            )}
            onChange={(event) => change(param.options?.[Number(event.target.value)]?.value)}
            className="h-8 text-xs"
          >
            <option value="-1">—</option>
            {param.options?.map((option, index) => (
              <option key={index} value={String(index)}>
                {option.label}
              </option>
            ))}
          </UiSelect>
        ) : param.type === "boolean" ? (
          <UiSegmented
            aria-label={param.label}
            size="sm"
            value={value === undefined ? "" : String(value)}
            onChange={(next) => change(next === "" ? undefined : next === "true")}
            options={[
              { value: "", label: "—" },
              { value: "true", label: t("channelModes.on") },
              { value: "false", label: t("channelModes.off") },
            ]}
          />
        ) : (
          <UiInput
            aria-label={param.label}
            type={param.type === "number" ? "number" : "text"}
            min={param.min}
            max={param.max}
            step={param.step}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(event) =>
              change(
                event.target.value === ""
                  ? undefined
                  : param.type === "number"
                    ? Number(event.target.value)
                    : event.target.value,
              )
            }
            className="h-8 text-xs"
          />
        )}
      </UiField>
    );
  };
  return (
    <div className="mt-3 border-t border-[var(--line)] pt-2.5">
      {basic.length ? <div className={GRID}>{basic.map(field)}</div> : null}
      {advanced.length ? (
        <details className={`group ${basic.length ? "mt-3" : ""}`}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-text-muted hover:text-text-dark [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-90" />
            {t("channelModes.advanced")}
            <span className="ui-badge">{advanced.length}</span>
          </summary>
          <div className={`mt-3 ${GRID}`}>{advanced.map(field)}</div>
        </details>
      ) : null}
    </div>
  );
}
