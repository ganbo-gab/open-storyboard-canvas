import { EyeOff, Lock, Trash2, Unlock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UiButton } from '@/components/ui';
import type { StageSelectionOperation } from '../application/stageSelection';

export function StageSelectionBar({ count, locked, onApply }: { count: number; locked: boolean; onApply: (operation: StageSelectionOperation) => void }) {
  const { t } = useTranslation();
  if (count < 2) return null;
  return <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-elevated p-2 shadow-lg" aria-label={t('ui.stage.selection.actions')}>
    <span className="px-2 text-xs text-text-muted">{t('ui.stage.selection.count', { count })}</span>
    <UiButton size="sm" variant="ghost" disabled={locked} onClick={() => onApply({ type: 'update', patch: { hidden: true } })}><EyeOff className="h-3.5 w-3.5" />{t('ui.stage.selection.hide')}</UiButton>
    <UiButton size="sm" variant="ghost" onClick={() => onApply({ type: 'update', patch: { locked: !locked } })}>{locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{t(locked ? 'ui.stage.selection.unlock' : 'ui.stage.selection.lock')}</UiButton>
    <UiButton size="sm" variant="ghost" disabled={locked} onClick={() => onApply({ type: 'remove' })}><Trash2 className="h-3.5 w-3.5" />{t('common.delete')}</UiButton>
  </div>;
}
