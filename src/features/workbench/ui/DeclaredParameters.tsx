import { useTranslation } from "react-i18next";
import type { ParamSpec } from "@/features/channels/domain/profile";

type Props = {
  params: ParamSpec[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
};
export function DeclaredParameters({ params, values, onChange }: Props) {
  const { t } = useTranslation();
  if (!params.length) return null;
  return (
    <details className="mt-3 border-t border-border-dark pt-3">
      <summary className="cursor-pointer text-xs text-text-muted">
        {t("rework.channels.profile")} · {params.length}
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {params.map((param) => {
          const value = values[param.key] ?? param.default;
          const change = (next: unknown) => {
            const updated = { ...values };
            if (next === undefined) delete updated[param.key];
            else updated[param.key] = next;
            onChange(updated);
          };
          return (
            <label key={param.key} className="min-w-0 text-xs text-text-muted">
              <span className="mb-1.5 block truncate">
                {param.label}
                {param.required ? " *" : ""}
              </span>
              {param.type === "enum" ? (
                <select
                  aria-label={param.label}
                  value={
                    param.options?.findIndex(
                      (option) =>
                        JSON.stringify(option.value) === JSON.stringify(value),
                    ) ?? -1
                  }
                  onChange={(event) =>
                    change(param.options?.[Number(event.target.value)]?.value)
                  }
                  className="h-9 w-full rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                >
                  <option value={-1}>—</option>
                  {param.options?.map((option, index) => (
                    <option key={index} value={index}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : param.type === "boolean" ? (
                <select
                  aria-label={param.label}
                  value={value === undefined ? "" : String(value)}
                  onChange={(event) =>
                    change(
                      event.target.value === ""
                        ? undefined
                        : event.target.value === "true",
                    )
                  }
                  className="h-9 w-full rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                >
                  <option value="">—</option>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              ) : (
                <input
                  aria-label={param.label}
                  type={param.type === "number" ? "number" : "text"}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={
                    value === undefined || value === null ? "" : String(value)
                  }
                  onChange={(event) =>
                    change(
                      event.target.value === ""
                        ? undefined
                        : param.type === "number"
                          ? Number(event.target.value)
                          : event.target.value,
                    )
                  }
                  className="h-9 w-full rounded-lg border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                />
              )}
            </label>
          );
        })}
      </div>
    </details>
  );
}
