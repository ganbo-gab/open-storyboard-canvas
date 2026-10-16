import { sanitizeProviderUrlInput } from '@/features/channels/adapters/comfyui/url';
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;


function repairMalformedProviderScheme(value: string): string {
  let repaired = value;
  repaired = repaired.replace(/^(https?):\/\/(https?)(?=[:/])(?::?\/{0,2})/i, '$2://');
  repaired = repaired.replace(/^(https?)\/\//i, '$1://');
  repaired = repaired.replace(/^(https?):\/([^/])/i, '$1://$2');
  return repaired;
}

function extractHostFromAuthority(authority: string): string {
  const withoutCredentials = authority.split('@').pop() ?? authority;
  if (withoutCredentials.startsWith('[')) {
    return withoutCredentials.slice(1, withoutCredentials.indexOf(']'));
  }
  return withoutCredentials.split(':')[0] ?? '';
}

function extractHostFromNoScheme(value: string): string {
  const withoutSlashes = value.startsWith('//') ? value.slice(2) : value;
  const authority = withoutSlashes.split(/[/?#]/, 1)[0] ?? '';
  return extractHostFromAuthority(authority).toLowerCase();
}

function isPrivateOrLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function defaultSchemeForProviderHost(host: string): 'http' | 'https' {
  return isPrivateOrLocalHost(host) ? 'http' : 'https';
}

function addDefaultScheme(value: string): string {
  if (!value) return value;
  if (HTTP_SCHEME_PATTERN.test(value)) return value;
  if (value.startsWith('//')) {
    return `${defaultSchemeForProviderHost(extractHostFromNoScheme(value))}:${value}`;
  }

  let noScheme = value;
  if (/^::1(?::\d+)?(?:[/?#]|$)/.test(noScheme)) {
    noScheme = `[::1]${noScheme.slice(3)}`;
  }
  return `${defaultSchemeForProviderHost(extractHostFromNoScheme(noScheme))}://${noScheme}`;
}

function stripTrailingUrlSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeUrlPathForComparison(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped || '/';
}

function extractEndpointPathname(endpointPath: string): string {
  try {
    return new URL(endpointPath, 'https://provider.local').pathname;
  } catch {
    return endpointPath.split(/[?#]/, 1)[0] ?? endpointPath;
  }
}

function baseUrlAlreadyIncludesEndpointPath(baseUrl: string, endpointPath: string): boolean {
  if (!baseUrl || !endpointPath || endpointPath === '/') return false;
  try {
    const basePath = normalizeUrlPathForComparison(new URL(baseUrl).pathname);
    const endpointPathname = extractEndpointPathname(endpointPath);
    const endpoint = normalizeUrlPathForComparison(endpointPathname.startsWith('/') ? endpointPathname : `/${endpointPathname}`);
    return basePath === endpoint || basePath.endsWith(endpoint);
  } catch {
    return false;
  }
}

export function normalizeProviderBaseUrl(value: string): string {
  const sanitized = sanitizeProviderUrlInput(value);
  if (!sanitized) return '';

  const withScheme = addDefaultScheme(repairMalformedProviderScheme(sanitized));
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return stripTrailingUrlSlashes(withScheme);
    }
    return stripTrailingUrlSlashes(parsed.toString());
  } catch {
    return stripTrailingUrlSlashes(withScheme);
  }
}

export function normalizeProviderEndpointPath(value: string): string {
  const sanitized = sanitizeProviderUrlInput(value);
  if (!sanitized) return '';
  const repaired = repairMalformedProviderScheme(sanitized);
  if (HTTP_SCHEME_PATTERN.test(addDefaultScheme(repaired)) && (HTTP_SCHEME_PATTERN.test(repaired) || /^https?:\/?/i.test(repaired))) {
    return normalizeProviderBaseUrl(repaired);
  }
  return repaired.startsWith('/') ? repaired : `/${repaired}`;
}

export function buildProviderUrl(
  baseUrl: string,
  endpointPath: string,
  queryParams: Record<string, string> = {},
): string {
  const normalizedEndpointPath = normalizeProviderEndpointPath(endpointPath);
  const joined = (() => {
    if (normalizedEndpointPath && HTTP_SCHEME_PATTERN.test(normalizedEndpointPath)) {
      return normalizedEndpointPath;
    }
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (!normalizedEndpointPath) {
      return normalizedBaseUrl;
    }
    if (baseUrlAlreadyIncludesEndpointPath(normalizedBaseUrl, normalizedEndpointPath)) {
      return normalizedBaseUrl;
    }
    return `${normalizedBaseUrl}${normalizedEndpointPath.startsWith('/') ? '' : '/'}${normalizedEndpointPath}`;
  })();
  const qs = Object.entries(queryParams)
    .filter(([key]) => key.trim())
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return qs ? `${joined}${joined.includes('?') ? '&' : '?'}${qs}` : joined;
}

export function ensureProviderBaseUrlDirectory(baseUrl: string): string | null {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (!normalized) return null;
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}
