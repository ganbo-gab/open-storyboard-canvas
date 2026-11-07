import { Check, Moon, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiInput, UiSegmented, UiSwitch } from '@/components/ui';
import {
  DEFAULT_ACCENT_COLOR,
  THEME_TONE_PRESETS,
  useSettingsStore,
  type ThemeTonePreset,
  type UiRadiusPreset,
} from '@/stores/settingsStore';
import { useThemeStore } from '@/stores/themeStore';

const ACCENT_SWATCHES = ['#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#EF4444', '#F97316', '#EAB308', '#10B981', '#14B8A6', '#0EA5E9'] as const;

/** A live miniature of the app frame, painted by the theme's own tokens (`data-theme-tone` scopes them). */
function ThemePreview({ tone }: { tone: ThemeTonePreset }) {
  return (
    <div data-theme-tone={tone} className="flex h-[88px] overflow-hidden rounded-[var(--r-md)] border border-line bg-bg" aria-hidden>
      <div className="flex w-[30%] flex-col gap-1.5 border-r border-line bg-chrome px-2 py-2.5">
        <span className="h-1.5 w-3/4 rounded-full bg-text/70" />
        <span className="mt-1 h-3 w-full rounded-[4px] bg-accent/20" />
        <span className="h-1.5 w-2/3 rounded-full bg-text-muted/45" />
        <span className="h-1.5 w-3/4 rounded-full bg-text-muted/45" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="flex flex-1 flex-col gap-1.5 rounded-[6px] border border-line bg-surface p-1.5">
          <span className="h-1.5 w-4/5 rounded-full bg-text/70" />
          <span className="h-1.5 w-3/5 rounded-full bg-text-subtle/50" />
          <div className="mt-auto flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-cap-chat" />
            <span className="h-1.5 w-1.5 rounded-full bg-cap-image" />
            <span className="h-1.5 w-1.5 rounded-full bg-cap-video" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          <span className="h-2.5 w-7 rounded-full bg-raised" />
          <span className="h-2.5 w-9 rounded-full bg-accent" />
        </div>
      </div>
    </div>
  );
}

function SettingsCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--r-lg)] border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/** Appearance controls that apply instantly: light/dark, color theme, accent and corner radius. */
export function AppearanceThemeSettings() {
  const { t } = useTranslation();
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const tone = useSettingsStore((state) => state.themeTonePreset);
  const setTone = useSettingsStore((state) => state.setThemeTonePreset);
  const accentSource = useSettingsStore((state) => state.accentSource);
  const accentColor = useSettingsStore((state) => state.accentColor);
  const setAccentSource = useSettingsStore((state) => state.setAccentSource);
  const setAccentColor = useSettingsStore((state) => state.setAccentColor);
  const radius = useSettingsStore((state) => state.uiRadiusPreset);
  const setRadius = useSettingsStore((state) => state.setUiRadiusPreset);
  const followTheme = accentSource === 'theme';
  const [hexDraft, setHexDraft] = useState(accentColor);
  useEffect(() => setHexDraft(accentColor), [accentColor]);

  return (
    <div className="space-y-4">
      <SettingsCard title={t('ui.theme.mode.title')} description={t('ui.theme.mode.desc')}>
        <UiSegmented
          value={theme}
          onChange={setTheme}
          aria-label={t('ui.theme.mode.title')}
          className="w-[240px]"
          options={[
            { value: 'light', label: t('ui.theme.mode.light'), icon: <Sun /> },
            { value: 'dark', label: t('ui.theme.mode.dark'), icon: <Moon /> },
          ]}
        />
      </SettingsCard>

      <SettingsCard title={t('ui.theme.palette.title')} description={t('ui.theme.palette.desc')}>
        <div role="radiogroup" aria-label={t('ui.theme.palette.title')} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {THEME_TONE_PRESETS.map((preset) => {
            const selected = preset === tone;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTone(preset)}
                className={`group relative flex flex-col gap-2 rounded-[var(--r-lg)] p-1.5 text-left transition-[box-shadow,background-color] duration-[var(--dur-2)] ${
                  selected ? 'bg-accent/8 shadow-[0_0_0_2px_rgb(var(--accent-rgb))]' : 'hover:bg-[var(--hover)] shadow-[0_0_0_1px_var(--line)]'
                }`}
              >
                <ThemePreview tone={preset} />
                <span className="flex items-center gap-1.5 px-1 pb-0.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-text">{t(`ui.theme.tones.${preset}.name`)}</span>
                    <span className="block truncate text-xs text-text-subtle">{t(`ui.theme.tones.${preset}.desc`)}</span>
                  </span>
                  {selected && (
                    <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent text-[var(--accent-fg)]">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard title={t('ui.theme.accent.title')} description={t('ui.theme.accent.desc')}>
        <label className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-text">{t('ui.theme.accent.followTheme')}</span>
          <UiSwitch
            checked={followTheme}
            onCheckedChange={(checked) => setAccentSource(checked ? 'theme' : 'custom')}
            aria-label={t('ui.theme.accent.followTheme')}
          />
        </label>
        {!followTheme && (
          <div className="mt-3.5 space-y-3">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('ui.theme.accent.swatches')}>
              {ACCENT_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={accentColor === swatch}
                  aria-label={swatch}
                  onClick={() => setAccentColor(swatch)}
                  className={`h-7 w-7 rounded-full transition-transform duration-[var(--dur-1)] hover:scale-110 ${
                    accentColor === swatch ? 'shadow-[0_0_0_2px_rgb(var(--surface-rgb)),0_0_0_4px_rgb(var(--text-rgb)/0.7)]' : ''
                  }`}
                  style={{ background: swatch }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <UiInput
                type="color"
                value={accentColor}
                onChange={(event) => setAccentColor(event.target.value)}
                aria-label={t('ui.theme.accent.picker')}
                className="h-9 w-12 p-1"
              />
              <UiInput
                value={hexDraft}
                onChange={(event) => {
                  setHexDraft(event.target.value);
                  if (/^#[0-9a-f]{6}$/i.test(event.target.value)) setAccentColor(event.target.value);
                }}
                onBlur={() => setHexDraft(accentColor)}
                placeholder={DEFAULT_ACCENT_COLOR}
                aria-label={t('ui.theme.accent.hex')}
                className="w-32 font-mono"
              />
              <UiButton size="sm" variant="ghost" onClick={() => setAccentSource('theme')}>
                {t('ui.theme.accent.reset')}
              </UiButton>
            </div>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title={t('ui.theme.radius.title')} description={t('ui.theme.radius.desc')}>
        <UiSegmented<UiRadiusPreset>
          value={radius}
          onChange={setRadius}
          aria-label={t('ui.theme.radius.title')}
          className="w-[300px]"
          options={[
            { value: 'compact', label: t('ui.theme.radius.compact') },
            { value: 'default', label: t('ui.theme.radius.default') },
            { value: 'large', label: t('ui.theme.radius.large') },
          ]}
        />
      </SettingsCard>
    </div>
  );
}
