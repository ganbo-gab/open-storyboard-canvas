/**
 * The app's location lives in the URL hash (`#/workbench`, `#/canvas/<projectId>`), so a reload,
 * a dev-server restart or a crash-recovery restart lands where the user was. Hash routing works
 * the same under Tauri's custom protocol and in the browser.
 */
export type StudioView = 'home' | 'projects' | 'canvas' | 'workbench' | 'assets' | 'prompts' | 'agent' | 'characters' | 'library' | 'knowledge';

export type AppLocation =
  | { view: 'canvas'; projectId: string }
  | { view: Exclude<StudioView, 'canvas'> };

const PAGE_VIEWS: Record<Exclude<StudioView, 'canvas'>, true> = {
  home: true,
  projects: true,
  workbench: true,
  assets: true,
  prompts: true,
  agent: true,
  characters: true,
  library: true,
  knowledge: true,
};

export function parseAppLocation(hash: string): AppLocation {
  const [view = '', id = ''] = hash.replace(/^#\/?/, '').split('/');
  if (view === 'canvas' && id) return { view: 'canvas', projectId: decodeURIComponent(id) };
  if (Object.hasOwn(PAGE_VIEWS, view)) return { view: view as Exclude<StudioView, 'canvas'> };
  return { view: 'home' };
}

/** Where the app was when this page load started; read before any view effect rewrites the hash. */
export const launchLocation: AppLocation = parseAppLocation(window.location.hash);

/**
 * A canvas launch first renders home while projects hydrate. Until the reopen attempt finishes,
 * that transient view must not overwrite the hash, or a reload during startup loses the canvas.
 */
let launchSettled = launchLocation.view !== 'canvas';

/** Called once the launch canvas was reopened (or found missing); `fallback` is written if it was not. */
export function settleLaunchLocation(fallback: AppLocation | null): void {
  launchSettled = true;
  if (fallback) writeAppLocation(fallback);
}

export function formatAppLocation(location: AppLocation): string {
  return location.view === 'canvas'
    ? `#/canvas/${encodeURIComponent(location.projectId)}`
    : `#/${location.view}`;
}

/** Record the location without adding a history entry (there is no browser chrome to go back with). */
export function writeAppLocation(location: AppLocation): void {
  if (!launchSettled) return;
  const next = formatAppLocation(location);
  if (window.location.hash === next) return;
  window.history.replaceState(window.history.state, '', next);
}
