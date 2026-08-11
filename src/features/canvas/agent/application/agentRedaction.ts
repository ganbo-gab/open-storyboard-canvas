const SECRET_KEY = /(?:api.?key|authorization|cookie|token|secret|password|credential|private.?key)/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(:=])(?:~[\\/]|\\\\|[A-Za-z]:\\|[\\/](?:Users|home|Volumes|private|var|tmp|opt|etc|Library|Applications|System|dev|mnt)(?:[\\/]|$))/i;
const DATA_PAYLOAD = /^(?:data:|blob:)/i;
const RAW_BASE64 = /(?:^|[^A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{512,}={0,2}(?:$|[^A-Za-z0-9+/_=-])/;
const CREDENTIAL_ASSIGNMENT = /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|secret|password)\s*[:=]\s*)[^\s,;&#]+/gi;
const SECRET_QUERY_VALUE = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|sig|auth|authorization|credential|x-amz-signature)=)[^&#]+/gi;

export function redactSensitiveValue<T>(value: T, depth = 0): T {
  if (depth > 6) return '[redacted-depth]' as T;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATA_PAYLOAD.test(trimmed) || RAW_BASE64.test(trimmed)) return '[redacted-media]' as T;
    if (ABSOLUTE_PATH.test(value)) return '[redacted-path]' as T;
    if (value.length > 5000) return `[redacted-long-value:${value.length}]` as T;
    return value
      .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
      .replace(SECRET_QUERY_VALUE, '$1[redacted]')
      .replace(CREDENTIAL_ASSIGNMENT, '$1[redacted]') as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? '[configured]' : redactSensitiveValue(child, depth + 1);
    }
    return output as T;
  }
  return value;
}

export function scanForSensitiveOutput(value: unknown): string[] {
  const issues: string[] = [];
  const walk = (current: unknown, path: string, depth: number): void => {
    if (depth > 8) { issues.push(`${path}: depth-limit`); return; }
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if (DATA_PAYLOAD.test(trimmed) || RAW_BASE64.test(trimmed)) issues.push(`${path}: media-payload`);
      if (ABSOLUTE_PATH.test(current)) issues.push(`${path}: absolute-path`);
      if (/Bearer\s+[A-Za-z0-9._-]{12,}/i.test(current)) issues.push(`${path}: bearer-token`);
      if (SECRET_QUERY_VALUE.test(current)) issues.push(`${path}: secret-query`);
      SECRET_QUERY_VALUE.lastIndex = 0;
      if (CREDENTIAL_ASSIGNMENT.test(current)) issues.push(`${path}: credential-assignment`);
      CREDENTIAL_ASSIGNMENT.lastIndex = 0;
      return;
    }
    if (Array.isArray(current)) { current.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
    if (current && typeof current === 'object') Object.entries(current).forEach(([key, child]) => {
      if (SECRET_KEY.test(key)) issues.push(`${path}.${key}: secret-key`);
      walk(child, `${path}.${key}`, depth + 1);
    });
  };
  walk(value, '$', 0);
  return issues;
}
