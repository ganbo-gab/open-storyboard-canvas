import type { JsonValue, ParamSpec } from '../domain/profile';

/** Presets use MAX_SAFE_INTEGER for "as many references as the upstream accepts". */
export const UNLIMITED_REFERENCES = 1000;

function valueText(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Compact value range for a declared parameter: 「480p / 720p / 1080p」「4–15」. Booleans/text return null. */
export function paramValueSummary(param: ParamSpec): string | null {
  if (param.type === 'enum') {
    const labels = (param.options ?? []).map((option) => option.label || valueText(option.value));
    const numeric = labels.filter((label) => label.trim() !== '' && Number.isFinite(Number(label))).map(Number);
    const named = labels.filter((label) => !(label.trim() !== '' && Number.isFinite(Number(label))));
    const parts = numeric.length > 3 ? [`${Math.min(...numeric)}–${Math.max(...numeric)}`, ...named] : labels;
    return parts.length > 5 ? `${parts.slice(0, 4).join(' / ')} …` : parts.join(' / ');
  }
  if (param.type === 'number') {
    if (param.min !== undefined && param.max !== undefined) return `${param.min}–${param.max}`;
    if (param.min !== undefined) return `≥ ${param.min}`;
    if (param.max !== undefined) return `≤ ${param.max}`;
  }
  return null;
}

export function paramDefaultText(param: ParamSpec): string | null {
  if (param.default === undefined) return null;
  if (param.type === 'enum') {
    const match = param.options?.find((option) => JSON.stringify(option.value) === JSON.stringify(param.default));
    if (match) return match.label;
  }
  return valueText(param.default);
}
