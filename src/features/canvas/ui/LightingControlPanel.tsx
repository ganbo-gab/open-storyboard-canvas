import { memo, useState, useCallback, useEffect } from 'react';
import { X, RotateCcw, Sun } from 'lucide-react';

// Lighting reference photos live in `public/lighting-presets/` so Vite
// serves them as static files instead of inlining their ~18MB combined
// weight into the JS bundle. The strings below are runtime URLs handled
// by the Tauri webview's static asset loader.
const overexposedPreset = '/lighting-presets/overexposed.png';
const blueBacklightPreset = '/lighting-presets/blue-backlight.png';
const rembrandtPreset = '/lighting-presets/rembrandt.png';
const cyberpunkPreset = '/lighting-presets/cyberpunk.png';
const sunsetPreset = '/lighting-presets/sunset.png';
const mysteriousPreset = '/lighting-presets/mysterious.png';
const goldenHourPreset = '/lighting-presets/golden-hour.png';
const nolanGreyPreset = '/lighting-presets/nolan-grey.png';
import {
  buildLightingPromptFromTemplate,
} from '@/features/canvas/application/panelPromptBuilders';
import {
  DEFAULT_LIGHTING_PROMPT_TEMPLATE,
  useSettingsStore,
} from '@/stores/settingsStore';
import { LightingSphereControl } from './LightingSphereControl';
import { PromptTemplateDialog } from './PromptTemplateDialog';
import { ModelConfigPicker } from './ModelConfigPicker';

export interface LightingControlOptions {
  enabled: boolean;
  azimuth: number;
  elevation: number;
  brightness: number;
  rimLight: boolean;
  stylePreset: string;
  smartMode: boolean;
  lightColor: string;
}

const LIGHT_POSITIONS = [
  { label: '左侧', azimuth: 270, elevation: 0 },
  { label: '顶部', azimuth: 0, elevation: 80 },
  { label: '右侧', azimuth: 90, elevation: 0 },
  { label: '前方', azimuth: 0, elevation: 0 },
  { label: '底部', azimuth: 0, elevation: -80 },
  { label: '后方', azimuth: 180, elevation: 0 },
];

const STYLE_PRESETS = [
  { id: 'overexposed', name: '过曝胶片', color: '#d4b896', image: overexposedPreset, prompt: 'overexposed film aesthetic, high-key lighting, washed out highlights, soft diffused light, vintage film look' },
  { id: 'blueBacklight', name: '蓝色逆光', color: '#1a3a5c', image: blueBacklightPreset, prompt: 'dramatic backlighting, blue rim light, cool color temperature, silhouette with colored edges, ethereal atmosphere' },
  { id: 'rembrandt', name: '伦勃朗光', color: '#5a3a1a', image: rembrandtPreset, prompt: 'Rembrandt lighting, 45-degree angle key light, dramatic chiaroscuro, painterly shadows, classical portraiture' },
  { id: 'cyberpunk', name: '赛博朋克', color: '#2a0a2a', image: cyberpunkPreset, prompt: 'cyberpunk neon lighting, synthetic glow, futuristic atmosphere, vibrant cyan and magenta neon' },
  { id: 'sunset', name: '落日迷幻', color: '#7a3010', image: sunsetPreset, prompt: 'golden hour lighting, warm sunset tones, long shadow, romantic atmosphere, Kodachrome colors' },
  { id: 'mysterious', name: '神秘暗调', color: '#0a0a14', image: mysteriousPreset, prompt: 'low-key noir lighting, deep shadows, mysterious mood, film noir style, high contrast cinematic' },
  { id: 'goldenHour', name: '黄金时刻', color: '#7a5a00', image: goldenHourPreset, prompt: 'golden hour photography, warm soft light, beautiful catchlights, lens flare, magical golden glow' },
  { id: 'nolanGrey', name: '诺兰冷灰', color: '#1a2a2a', image: nolanGreyPreset, prompt: 'Christopher Nolan cinematography, IMAX quality, desaturated cold palette, teal and grey grading' },
];

interface LightingControlPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (options: LightingControlOptions, prompt: string) => void;
  onCopyPrompt?: (prompt: string) => void;
  buttonRect: DOMRect;
  previewImageUrl?: string | null;
}

export const LightingControlPanel = memo(
  ({ isOpen, onClose, onApply, onCopyPrompt, buttonRect, previewImageUrl }: LightingControlPanelProps) => {
    const [azimuth, setAzimuth] = useState(0);
    const [elevation, setElevation] = useState(0);
    const [brightness, setBrightness] = useState(50);
    const [rimLight, setRimLight] = useState(false);
    const [stylePreset, setStylePreset] = useState('');
    const [smartMode, setSmartMode] = useState(true);
    const [smartDesc, setSmartDesc] = useState('');
    const [lightColor, setLightColor] = useState('#ffffff');
    const [viewMode, setViewMode] = useState<'perspective' | 'front'>('perspective');
    const [isTemplateDialogOpen, setIsTemplateDialogOpen] = useState(false);
    const lightingPromptTemplate = useSettingsStore((state) => state.lightingPromptTemplate);
    const setLightingPromptTemplate = useSettingsStore((state) => state.setLightingPromptTemplate);
    const resetLightingPromptTemplate = useSettingsStore((state) => state.resetLightingPromptTemplate);

    useEffect(() => {
      if (isOpen) {
        setAzimuth(0);
        setElevation(0);
        setBrightness(50);
        setRimLight(false);
        setStylePreset('');
        setSmartMode(true);
        setSmartDesc('');
        setLightColor('#ffffff');
        setViewMode('perspective');
      }
    }, [isOpen]);

    const buildPrompt = useCallback(() => {
      const presetPrompt = stylePreset
        ? (STYLE_PRESETS.find((p) => p.id === stylePreset)?.prompt ?? '')
        : '';
      const smartDescPrompt = smartMode ? smartDesc.trim() : '';

      // Map azimuth/elevation to human-readable direction. Avoids raw "main light from azimuth 270°"
      // which the model tends to ignore, and avoids language that would make the model literally
      // paint a light fixture inside the frame.
      const directionName = (() => {
        const az = ((azimuth % 360) + 360) % 360;
        const el = elevation;
        if (el >= 60) return 'strong top-down key light from directly above';
        if (el <= -60) return 'strong upward uplight from directly below the subject';
        const azName = az >= 345 || az <= 15
          ? 'coming from the front'
          : az > 15 && az < 75
            ? 'coming from the front-right at 45 degrees'
            : az >= 75 && az <= 105
              ? 'coming from the right side, pure side-light'
              : az > 105 && az < 165
                ? 'coming from the back-right, creating rim and edge light'
                : az >= 165 && az <= 195
                  ? 'coming from directly behind the subject, strong backlight and silhouette'
                  : az > 195 && az < 255
                    ? 'coming from the back-left, creating rim and edge light'
                    : az >= 255 && az <= 285
                      ? 'coming from the left side, pure side-light'
                      : 'coming from the front-left at 45 degrees';
        const elName = el >= 30
          ? ', tilted downward from above'
          : el <= -30
            ? ', tilted upward from below'
            : '';
        return `main key light ${azName}${elName}`;
      })();

      const lightDirectionPrompt = directionName;

      const brightnessPrompt = brightness >= 75
        ? 'high-key, bright and well-lit scene, lifted exposure'
        : brightness <= 25
          ? 'low-key, dim and moody scene, deep shadows, reduced exposure'
          : brightness === 50
            ? ''
            : brightness > 50
              ? 'slightly brighter exposure'
              : 'slightly darker exposure';

      const rimLightPrompt = rimLight
        ? 'add clear rim light and edge highlight along the silhouette'
        : '';

      const lightColorPrompt = lightColor && lightColor.toLowerCase() !== '#ffffff'
        ? `key light color temperature tinted toward ${lightColor}`
        : '';

      const lightingMeta = `[lighting azimuth:${azimuth}° elevation:${elevation}° brightness:${brightness}%${rimLight ? ' rim:on' : ''}]`;

      const consistencyPrompt = [
        'this is a lighting-only edit of the reference image: same scene, same people, same action, same clothing, same background, only the lighting changes',
        'the following instructions describe how light falls on the subject, they are not new objects to add to the scene',
        'do not add any lamp, spotlight, light fixture, reflector, softbox, torch, candle, or photography equipment into the image',
        'preserve identity, face, outfit, hairstyle, body pose, and the background layout from the input image',
        'if multiple people are present, preserve the same number of people and their spatial relationship',
        'only change lighting direction, light color, brightness, shadows, contrast, and mood',
      ].join(', ');

      return buildLightingPromptFromTemplate({
        template: lightingPromptTemplate,
        consistencyPrompt,
        presetPrompt,
        smartDesc: smartDescPrompt,
        lightDirectionPrompt,
        brightnessPrompt,
        rimLightPrompt,
        lightColorPrompt,
        lightingMeta,
      });
    }, [stylePreset, smartMode, smartDesc, azimuth, elevation, brightness, rimLight, lightColor, lightingPromptTemplate]);

    const handleApply = useCallback(() => {
      onApply({
        enabled: true,
        azimuth,
        elevation,
        brightness,
        rimLight,
        stylePreset,
        smartMode,
        lightColor,
      }, buildPrompt());
    }, [azimuth, elevation, brightness, rimLight, stylePreset, smartMode, lightColor, onApply, buildPrompt]);

    const handleReset = useCallback(() => {
      setAzimuth(0);
      setElevation(0);
      setBrightness(50);
      setRimLight(false);
      setStylePreset('');
      setSmartMode(true);
      setSmartDesc('');
      setLightColor('#ffffff');
    }, []);

    const isPositionActive = (pos: { azimuth: number; elevation: number }) =>
      pos.azimuth === azimuth && pos.elevation === elevation;

    const panelWidth = 700;
    const brightnessSliderClassName = 'w-full h-[4px] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4.5 [&::-webkit-slider-thumb]:w-4.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,0.45)] [&::-moz-range-thumb]:h-4.5 [&::-moz-range-thumb]:w-4.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white';
    const presetBackgrounds: Record<string, string> = {
      overexposed: 'linear-gradient(135deg, #f1dcc8 0%, #c6ab8e 42%, #8a6f57 100%)',
      blueBacklight: 'linear-gradient(135deg, #1d2840 0%, #243b6d 48%, #7aa8ff 100%)',
      rembrandt: 'linear-gradient(135deg, #23160f 0%, #4f2f1d 48%, #c9a06a 100%)',
      cyberpunk: 'linear-gradient(135deg, #120818 0%, #3c0d4b 48%, #00d0ff 100%)',
      sunset: 'linear-gradient(135deg, #21110d 0%, #8d3a18 48%, #efb46f 100%)',
      mysterious: 'linear-gradient(135deg, #08090d 0%, #171922 52%, #40495a 100%)',
      goldenHour: 'linear-gradient(135deg, #2a1907 0%, #8d5d11 48%, #ffd36b 100%)',
      nolanGrey: 'linear-gradient(135deg, #10161c 0%, #2f3a44 52%, #8aa3b5 100%)',
    };
    const panelLeft = Math.min(Math.max(8, buttonRect.left), window.innerWidth - panelWidth - 8);
    const panelTop = buttonRect.bottom + 6;

    if (!isOpen) return null;

    return (
      <div
        className="fixed z-[200] rounded-xl border border-[rgba(255,255,255,0.1)] bg-[#202020] shadow-2xl"
        style={{ left: panelLeft, top: panelTop, width: panelWidth }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[rgba(255,255,255,0.08)]">
          <span className="text-sm font-semibold text-white">打光效果</span>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md text-[rgba(255,255,255,0.45)] hover:text-white hover:bg-[rgba(255,255,255,0.1)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex gap-0 p-0">
          {/* Left col: view tabs + sphere */}
          <div className="flex flex-col items-center gap-2 px-3 py-3 border-r border-[rgba(255,255,255,0.06)]" style={{ width: 185 }}>
            {/* 透视 / 正面 tabs */}
            <div className="flex gap-1 w-full mb-1 rounded-md bg-[rgba(255,255,255,0.04)] p-1">
              {(['perspective', 'front'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex-1 rounded-md py-1 text-[11px] font-medium transition-colors ${
                    viewMode === mode
                      ? 'bg-[rgba(255,255,255,0.14)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
                      : 'text-[rgba(255,255,255,0.38)] hover:text-[rgba(255,255,255,0.7)]'
                  }`}
                >
                  {mode === 'perspective' ? '透视' : '正面'}
                </button>
              ))}
            </div>

            {/* Sphere */}
            <LightingSphereControl
              azimuth={azimuth}
              elevation={elevation}
              onAngleChange={(az, el) => { setAzimuth(az); setElevation(el); }}
              previewImageUrl={previewImageUrl}
              viewMode={viewMode}
            />
          </div>

          {/* Middle col: controls */}
          <div className="flex flex-col gap-3 px-3 py-3 border-r border-[rgba(255,255,255,0.06)]" style={{ width: 210 }}>
            {/* 全局 label + 智能模式 toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[rgba(255,255,255,0.5)]">全局</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[rgba(255,255,255,0.7)]">智能模式</span>
                <button
                  type="button"
                  onClick={() => setSmartMode(!smartMode)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                    smartMode ? 'bg-accent' : 'bg-[rgba(255,255,255,0.15)]'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${smartMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>

            {/* 亮度 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[rgba(255,255,255,0.6)] w-6">亮度</span>
                <div className="flex-1">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={brightness}
                    onChange={(e) => setBrightness(Number(e.target.value))}
                    className={brightnessSliderClassName}
                    style={{
                      background: `linear-gradient(to right, rgba(255,255,255,0.88) ${brightness}%, rgba(255,255,255,0.14) ${brightness}%)`
                    }}
                  />
                </div>
                <div className="flex items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-2 py-1 text-[11px] text-[rgba(255,255,255,0.45)]">
                  <Sun className="w-3 h-3" />
                  <span className="w-8 text-right">{brightness}%</span>
                </div>
              </div>
            </div>

            {/* 颜色 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-[rgba(255,255,255,0.6)] w-6">颜色</span>
              <div className="relative flex items-center">
                <div
                  className="w-10 h-6 rounded border border-[rgba(255,255,255,0.15)] cursor-pointer overflow-hidden"
                  style={{ background: lightColor === '#ffffff' ? 'linear-gradient(135deg, #ff0000 0%, #ff9900 25%, #ffff00 50%, transparent 50%, transparent 100%), linear-gradient(45deg, #aaa 25%, transparent 25%, transparent 75%, #aaa 75%)' : lightColor }}
                  onClick={() => {
                    const inp = document.createElement('input');
                    inp.type = 'color';
                    inp.value = lightColor;
                    inp.onchange = (e) => setLightColor((e.target as HTMLInputElement).value);
                    inp.click();
                  }}
                />
                {lightColor === '#ffffff' && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-full h-px bg-red-500 rotate-45" />
                  </div>
                )}
              </div>
            </div>

            {/* 主光源 */}
            <div className="space-y-1.5">
              <span className="text-xs text-[rgba(255,255,255,0.5)]">主光源</span>
              <div className="grid grid-cols-3 gap-1">
                {LIGHT_POSITIONS.map((pos) => (
                  <button
                    key={pos.label}
                    onClick={() => { setAzimuth(pos.azimuth); setElevation(pos.elevation); }}
                    className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
                      isPositionActive(pos)
                        ? 'bg-white text-black'
                        : 'bg-[rgba(255,255,255,0.08)] text-[rgba(255,255,255,0.65)] hover:bg-[rgba(255,255,255,0.14)]'
                    }`}
                  >
                    {pos.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 轮廓光 */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[rgba(255,255,255,0.6)]">轮廓光</span>
              <button
                type="button"
                onClick={() => setRimLight(!rimLight)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                  rimLight ? 'bg-accent' : 'bg-[rgba(255,255,255,0.15)]'
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${rimLight ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Right col: smart input + presets */}
          <div className="flex flex-col gap-3 px-4 py-4 flex-1">
            {/* 智能模式 header */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[rgba(255,255,255,0.7)]">智能模式</span>
              <button className="flex items-center gap-1 rounded-md px-2 py-1 bg-[rgba(255,255,255,0.08)] text-xs text-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.14)] transition-colors">
                <span className="text-base leading-none">+</span>
                <span>打光参考图</span>
              </button>
            </div>

            {/* Smart description textarea */}
            <textarea
              value={smartDesc}
              onChange={(e) => setSmartDesc(e.target.value)}
              placeholder="简单描述你想要实现的打光效果，或者情绪风格"
              className="w-full h-16 resize-none rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.05)] px-3 py-2 text-xs text-[rgba(255,255,255,0.8)] placeholder-[rgba(255,255,255,0.25)] outline-none focus:border-[rgba(255,255,255,0.2)] transition-colors"
            />

            {/* 预设 label */}
            <span className="text-xs text-[rgba(255,255,255,0.5)]">预设</span>

            {/* Preset grid 2x4 */}
            <div className="grid grid-cols-2 gap-1.5">
              {STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => setStylePreset(stylePreset === preset.id ? '' : preset.id)}
                  className={`relative overflow-hidden rounded-lg h-[60px] text-left transition-[box-shadow,filter,border-color,background-color] duration-150 ${
                    stylePreset === preset.id
                      ? 'ring-2 ring-white/60 shadow-[0_0_0_1px_rgba(255,255,255,0.15)]'
                      : 'hover:ring-1 hover:ring-white/30'
                  }`}
                  style={{
                    backgroundImage: `linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.08)), url(${preset.image})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundColor: presetBackgrounds[preset.id] ?? preset.color,
                  }}
                >
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,rgba(255,255,255,0.22),transparent_36%)]" />
                  <span className="absolute bottom-1.5 left-2 right-2 text-[11px] font-medium text-white leading-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">
                    {preset.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[rgba(255,255,255,0.08)]">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 text-xs text-[rgba(255,255,255,0.45)] hover:text-white transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            重置参数
          </button>

          {/* Model picker — persisted per panel. Replaces the old stray 14 + ⚡ badge. */}
          <ModelConfigPicker panelKey="lighting" />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onCopyPrompt?.(buildPrompt())}
              className="rounded-md bg-[rgba(255,255,255,0.08)] px-3 py-1.5 text-xs text-[rgba(255,255,255,0.72)] transition-colors hover:bg-[rgba(255,255,255,0.14)]"
            >
              复制提示词
            </button>
            <button
              type="button"
              onClick={() => setIsTemplateDialogOpen(true)}
              className="rounded-md bg-[rgba(255,255,255,0.08)] px-3 py-1.5 text-xs text-[rgba(255,255,255,0.72)] transition-colors hover:bg-[rgba(255,255,255,0.14)]"
            >
              设置提示词
            </button>
            <button
              onClick={handleApply}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-white text-black hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        <PromptTemplateDialog
          isOpen={isTemplateDialogOpen}
          title="设置打光默认提示词"
          description="这里修改的是系统自动附加的默认打光描述骨架，不包含你当前选择的亮度、方向、颜色等参数值。面板参数会自动替换进去；智能模式里输入的文字会单独叠加。"
          value={lightingPromptTemplate}
          defaultValue={DEFAULT_LIGHTING_PROMPT_TEMPLATE}
          placeholders={[
            '{{consistencyPrompt}}',
            '{{presetPrompt}}',
            '{{smartDesc}}',
            '{{lightDirectionPrompt}}',
            '{{brightnessPrompt}}',
            '{{rimLightPrompt}}',
            '{{lightColorPrompt}}',
            '{{lightingMeta}}',
          ]}
          onClose={() => setIsTemplateDialogOpen(false)}
          onChange={setLightingPromptTemplate}
          onSave={() => undefined}
          onResetDefault={resetLightingPromptTemplate}
        />
      </div>
    );
  }
);

LightingControlPanel.displayName = 'LightingControlPanel';

export function buildLightingPromptFromOptions(options: LightingControlOptions): string {
  const presetPrompt = options.stylePreset
    ? (STYLE_PRESETS.find((p) => p.id === options.stylePreset)?.prompt ?? '')
    : '';
  const consistencyPrompt = [
    'this is a lighting-only edit of the reference image: same scene, same people, same action, same clothing, same background, only the lighting changes',
    'do not add any lamp, spotlight, light fixture, reflector, softbox, torch, candle, or photography equipment into the image',
    'preserve identity, face, outfit, hairstyle, body pose, and the background layout from the input image',
  ].join(', ');
  return buildLightingPromptFromTemplate({
    template: '{{consistencyPrompt}}, {{presetPrompt}}, {{lightDirectionPrompt}}, {{brightnessPrompt}}, {{rimLightPrompt}}, {{lightColorPrompt}}, {{lightingMeta}}',
    consistencyPrompt,
    presetPrompt,
    smartDesc: '',
    lightDirectionPrompt: `main key light from azimuth ${options.azimuth} degrees, elevation ${options.elevation} degrees`,
    brightnessPrompt: options.brightness === 50 ? '' : `brightness ${options.brightness}%`,
    rimLightPrompt: options.rimLight ? 'add clear rim light and edge highlight along the silhouette' : '',
    lightColorPrompt: options.lightColor !== '#ffffff' ? `key light color tinted toward ${options.lightColor}` : '',
    lightingMeta: `[lighting azimuth:${options.azimuth}° elevation:${options.elevation}° brightness:${options.brightness}%]`,
  });
}
