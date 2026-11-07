import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { z } from 'zod';
import { UiButton, UiCheckbox, UiField, UiInput, UiSelect, UiTextArea } from '@/components/ui';
import type { JsonValue, ParamSpec } from '@/features/channels/domain/profile';
import { parameterIsAdvanced } from '@/features/channels/ui/parameterPresentation';
import { ComposerParameterPanel } from '@/features/workbench/ui/ComposerParameterPanel';
import { ParameterQuickSetup } from './ParameterQuickSetup';
import { FrameOptionSelection } from './FrameOptionSelection';
import { isFrameChoiceParameter } from './parameterOptionSelection';

function parseValue(raw: string): JsonValue | undefined {
  if (!raw.trim()) return undefined;
  try { return z.json().parse(JSON.parse(raw)); } catch { return raw; }
}
function optionsFromText(text: string): NonNullable<ParamSpec['options']> {
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    const at = line.indexOf('='); const label = (at < 0 ? line : line.slice(0, at)).trim();
    return { label, value: parseValue(at < 0 ? line : line.slice(at + 1).trim()) ?? '' };
  });
}
function parseDefault(param: ParamSpec, raw: string): JsonValue | undefined {
  const parsed = parseValue(raw);
  if (parsed === undefined) return undefined;
  if (param.type === 'text') return typeof parsed === 'string' ? parsed : raw;
  return parsed;
}
const valueText = (value: JsonValue | undefined) => value === undefined ? '' : JSON.stringify(value);

/** Edit the actual declaration used by rendering and requests; preview values never change saved defaults. */
export function ParameterSchemaEditor({ params, onChange, title = '工作台参数' }: { params: ParamSpec[]; onChange(params: ParamSpec[]): void; title?: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const patch = (index: number, value: Partial<ParamSpec>) => onChange(params.map((param, i) => i === index ? { ...param, ...value } : param));
  const move = (index: number, step: number) => { const next = [...params]; [next[index], next[index + step]] = [next[index + step], next[index]]; onChange(next); };
  return <section className="min-w-0 space-y-3 rounded-xl border border-line p-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1 basis-60"><h4 className="text-sm font-medium">{title}</h4><p className="mt-1 text-xs text-text-muted">决定工作台显示的名称、选项与排列。隐藏只收起控件，参数默认值仍会发送。</p></div>
      <UiButton size="sm" className="shrink-0" onClick={() => { setPreview(!preview); setValues({}); }}>{preview ? '继续编辑' : '预览工作台'}</UiButton></header>
    {preview ? <ComposerParameterPanel params={params} values={values} onChange={setValues} /> : <>
      <ParameterQuickSetup params={params} onChange={onChange} />
      {params.map((param, index) => {
        const frame = isFrameChoiceParameter(param);
        return <details key={index} className="min-w-0 rounded-lg border border-line bg-surface" open={frame || params.length === 1 || undefined}>
        <summary className="cursor-pointer px-3 py-2 text-sm">{param.sizeDisplay === 'ratio-resolution' ? t('ui.channels.sizeGuide.ratio-resolution') : param.label || '未命名参数'} <span className="ml-2 font-mono text-xs text-text-subtle">{param.key}</span></summary>
        <div className="space-y-3 border-t border-line p-3">
          {frame && <FrameOptionSelection key={param.key} param={param} onChange={(next) => patch(index, next)} />}
          <details open={!frame || undefined}>
            <summary className={frame ? "cursor-pointer border-t border-line pt-3 text-xs text-text-muted" : "hidden"}>{t('ui.channels.frameOptions.advanced')}</summary>
            <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3"><UiField label="显示名称"><UiInput aria-label={`参数 ${index + 1} 显示名称`} value={param.label} onChange={(e) => patch(index, { label: e.target.value })} /></UiField>
            <UiField label="接口字段" hint="修改须与请求模板一致"><UiInput aria-label={`参数 ${index + 1} 接口字段`} value={param.key} onChange={(e) => patch(index, { key: e.target.value })} /></UiField></div>
          <div className="grid grid-cols-3 gap-3"><UiField label="值类型"><UiSelect value={param.type} onChange={(e) => patch(index, { type: z.enum(['enum','number','boolean','text']).parse(e.target.value), default: undefined, options: e.target.value === 'enum' ? [] : undefined })}><option value="enum">选项</option><option value="number">数字</option><option value="boolean">开关</option><option value="text">文本</option></UiSelect></UiField>
            <UiField label="放在哪里"><UiSelect value={parameterIsAdvanced(param) ? 'advanced' : 'basic'} onChange={(e) => patch(index, { group: z.enum(['basic','advanced']).parse(e.target.value) })}><option value="basic">常用参数</option><option value="advanced">高级参数</option></UiSelect></UiField>
            <UiField label="控件样式"><UiSelect value={param.display ?? 'auto'} onChange={(e) => patch(index, { display: z.enum(['auto','buttons','select','slider','hidden']).parse(e.target.value) })}><option value="auto">自动</option>{param.type === 'enum' && <><option value="buttons">按钮选项</option><option value="select">下拉列表</option></>}{(param.type === 'number' || param.type === 'enum') && <option value="slider">滑动选择</option>}<option value="hidden">隐藏控件</option></UiSelect></UiField></div>
          {param.display === 'slider' && <p className="text-xs text-text-muted">滑动选择用于递增数值选项或设有最小、最大值的数字。</p>}
          {param.type === 'enum' && <UiField label="选项（每行：显示文字=接口值）" hint={'例如 标准="1024x1024"；数字写 5；字符串数字写 "5"'}><UiTextArea aria-label={`参数 ${index + 1} 选项`} key={`${param.key}:${param.type}:${JSON.stringify(param.options)}`} defaultValue={(param.options ?? []).map((x) => `${x.label}=${valueText(x.value)}`).join('\n')} onBlur={(e) => patch(index, { options: optionsFromText(e.target.value).map(option => ({ ...option, size: param.options?.find(old => JSON.stringify(old.value) === JSON.stringify(option.value))?.size })) })} className="min-h-24 font-mono text-xs" /></UiField>}
          <div className="grid grid-cols-2 gap-3"><UiField label="默认值" hint="与接口真实值一致；清空表示不指定"><UiInput key={`${param.key}:${param.type}:${valueText(param.default)}`} aria-label={`参数 ${index + 1} 默认值`} defaultValue={valueText(param.default)} onBlur={(e) => patch(index, { default: parseDefault(param, e.target.value) })} /></UiField>
            <UiField label="说明"><UiInput value={param.description ?? ''} onChange={(e) => patch(index, { description: e.target.value })} /></UiField></div>
          {param.type === 'number' && <div className="grid grid-cols-3 gap-3">{(['min','max','step'] as const).map((key) => <UiField key={key} label={{min:'最小值',max:'最大值',step:'步长'}[key]}><UiInput type="number" value={param[key] ?? ''} onChange={(e) => patch(index, { [key]: e.target.value === '' ? undefined : Number(e.target.value) })} /></UiField>)}</div>}
          <div className="flex items-center justify-between gap-2"><label className="mr-auto flex items-center gap-2 text-xs"><UiCheckbox checked={param.required ?? false} onCheckedChange={(required) => patch(index, { required })} />必填参数</label><UiButton size="sm" aria-label={`上移参数 ${index + 1}`} disabled={index===0} onClick={() => move(index,-1)}><ArrowUp size={14} /></UiButton><UiButton size="sm" aria-label={`下移参数 ${index + 1}`} disabled={index===params.length-1} onClick={() => move(index,1)}><ArrowDown size={14} /></UiButton><UiButton size="sm" onClick={() => onChange(params.filter((_,i)=>i!==index))}><X size={14} />移除参数</UiButton></div>
            </div>
          </details>
        </div>
      </details>;})}
      <UiButton size="sm" icon={<Plus />} onClick={() => { let index=params.length+1;while(params.some(p=>p.key===`param${index}`))index++;onChange([...params,{key:`param${index}`,label:'新参数',type:'text',group:'basic'}]); }}>添加参数</UiButton>
    </>}
  </section>;
}
