import { z } from 'zod';

const issueSchema: z.ZodType<Issue> = z.lazy(() => z.object({
  code: z.string(), path: z.array(z.union([z.string(), z.number()])), message: z.string(),
  expected: z.string().optional(), values: z.array(z.json()).optional(), keys: z.array(z.string()).optional(),
  errors: z.array(z.array(issueSchema)).optional(),
}));
interface Issue { code: string; path: (string | number)[]; message: string; expected?: string; values?: unknown[]; keys?: string[]; errors?: Issue[][] }

function valueAt(value: unknown, path: (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    const object = z.record(z.string(), z.unknown()).safeParse(value);
    value = Array.isArray(value) && typeof key === 'number' ? value[key]
      : object.success ? object.data[String(key)] : undefined;
  }
  return value;
}
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function leaves(issues: Issue[], input: unknown, parent: (string | number)[] = []): Issue[] {
  return issues.flatMap(issue => {
    const path = [...parent, ...issue.path];
    if (!issue.errors?.length) return [{ ...issue, path }];
    const branches = issue.errors.map(branch => leaves(branch, input, path));
    // Invalid literal/shape mismatches identify unrelated union alternatives.
    // The nearest valid discriminator gets the precise missing/invalid fields.
    const score = (branch: Issue[]) => branch.reduce((sum, entry) => sum
      + (entry.code === 'invalid_value' && entry.values && !entry.values.some(value => sameJson(valueAt(input, entry.path), value)) ? 100 : 0)
      + (entry.code === 'invalid_type' && entry.expected === 'object' && Array.isArray(valueAt(input, entry.path)) ? 100 : 0)
      + 1, 0);
    return branches.reduce((best, branch) => score(branch) < score(best) ? branch : best, branches[0]);
  });
}

/** Bounded, value-free validation details; preserve paths/types without dumping every union alternative. */
export function scopedAgentValidationMessage(name: string, issues: unknown, input: unknown): string {
  const parsed = z.array(issueSchema).safeParse(issues);
  if (!parsed.success) return `Invalid ${name} arguments: the input does not match the tool schema.`;
  const messages = [...new Set(leaves(parsed.data, input).map(issue => {
    const path = issue.path.map((key, index) => typeof key === 'number' ? `[${key}]` : `${index ? '.' : ''}${key}`).join('') || '$';
    if (issue.code === 'invalid_type') return `${path}: expected ${issue.expected ?? 'declared type'}`;
    if (issue.code === 'invalid_value') return `${path}: value does not match the declared options`;
    if (issue.code === 'unrecognized_keys') return `${path}: contains unsupported fields`;
    return `${path}: ${issue.message.slice(0, 160)}`;
  }))];
  const detail = messages.slice(0, 5).join('; ');
  return `Invalid ${name} arguments: ${detail}${messages.length > 5 ? `; +${messages.length - 5} more validation issues` : ''}`;
}
