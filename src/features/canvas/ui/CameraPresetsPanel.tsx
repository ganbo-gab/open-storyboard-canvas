import { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { Save, Pencil, Trash2, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  type CameraPreset,
  getAllPresets,
  savePreset,
  updatePreset,
  deletePreset,
  presetToCameraControl,
} from '@/features/canvas/application/cameraPresetStore';
import type { CameraControlOptions } from '@/features/canvas/domain/canvasNodes';
import { UiPanel, UiButton, UiInput, UiModal } from '@/components/ui';

const CAMERA_LABELS: Record<string, string> = {
  panavision_dxl2: 'Panavision DXL2',
  arri_alexa_mini_lf: 'ARRI Alexa Mini LF',
  red_weapon_8k: 'RED Weapon 8K',
  sony_venice: 'Sony Venice',
  blackmagic_ursa: 'Blackmagic URSA',
};

const LENS_LABELS: Record<string, string> = {
  arri_signature_prime: 'ARRI Signature Prime',
  cooke_s7i: 'Cooke S7/i',
  zeiss_supreme_prime: 'Zeiss Supreme Prime',
  canon_cne: 'Canon CN-E',
  anamorphic: 'Anamorphic',
};

interface CameraPresetsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentCameraControl: CameraControlOptions | undefined;
  onApply: (cameraControl: CameraControlOptions) => void;
  openWithSaveDialog?: boolean;
}

interface SavePresetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}

const SavePresetDialog = memo(({ isOpen, onClose, onSave }: SavePresetDialogProps) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');

  useEffect(() => {
    if (isOpen) {
      setName('');
    }
  }, [isOpen]);

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed) {
      onSave(trimmed);
      onClose();
    }
  }, [name, onSave, onClose]);

  return (
    <UiModal
      isOpen={isOpen}
      title={t('cameraControl.preset.saveTitle')}
      onClose={onClose}
      footer={
        <>
          <UiButton variant="muted" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton variant="primary" size="sm" onClick={handleSave} disabled={!name.trim()}>
            {t('common.save')}
          </UiButton>
        </>
      }
    >
      <UiInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('cameraControl.preset.namePlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) {
            handleSave();
          }
        }}
        autoFocus
      />
    </UiModal>
  );
});

SavePresetDialog.displayName = 'SavePresetDialog';

interface EditPresetDialogProps {
  isOpen: boolean;
  preset: CameraPreset | null;
  onClose: () => void;
  onSave: (id: string, name: string) => void;
}

const EditPresetDialog = memo(({ isOpen, preset, onClose, onSave }: EditPresetDialogProps) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');

  useEffect(() => {
    if (isOpen && preset) {
      setName(preset.name);
    }
  }, [isOpen, preset]);

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed && preset) {
      onSave(preset.id, trimmed);
      onClose();
    }
  }, [name, preset, onSave, onClose]);

  return (
    <UiModal
      isOpen={isOpen}
      title={t('cameraControl.preset.editTitle')}
      onClose={onClose}
      footer={
        <>
          <UiButton variant="muted" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton variant="primary" size="sm" onClick={handleSave} disabled={!name.trim()}>
            {t('common.save')}
          </UiButton>
        </>
      }
    >
      <UiInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('cameraControl.preset.namePlaceholder')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) {
            handleSave();
          }
        }}
        autoFocus
      />
    </UiModal>
  );
});

EditPresetDialog.displayName = 'EditPresetDialog';

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  presetName: string;
  onClose: () => void;
  onConfirm: () => void;
}

const DeleteConfirmDialog = memo(
  ({ isOpen, presetName, onClose, onConfirm }: DeleteConfirmDialogProps) => {
    const { t } = useTranslation();

    return (
      <UiModal
        isOpen={isOpen}
        title={t('cameraControl.preset.deleteTitle')}
        onClose={onClose}
        footer={
          <>
            <UiButton variant="muted" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </UiButton>
            <UiButton
              variant="primary"
              size="sm"
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {t('common.delete')}
            </UiButton>
          </>
        }
      >
        <p className="text-sm text-text-dark">
          {t('cameraControl.preset.deleteConfirm', { name: presetName })}
        </p>
      </UiModal>
    );
  }
);

DeleteConfirmDialog.displayName = 'DeleteConfirmDialog';

interface PresetItemProps {
  preset: CameraPreset;
  onEdit: (preset: CameraPreset) => void;
  onDelete: (preset: CameraPreset) => void;
  onApply: (preset: CameraPreset) => void;
}

const PresetItem = memo(({ preset, onEdit, onDelete, onApply }: PresetItemProps) => {
  const { t } = useTranslation();

  const cameraLabel = CAMERA_LABELS[preset.camera] ?? preset.camera;
  const lensLabel = LENS_LABELS[preset.lens] ?? preset.lens;

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-white/10 bg-bg-dark/45 px-3 py-2 hover:border-white/20 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text-dark">{preset.name}</span>
          <div className="hidden group-hover:flex gap-0.5">
            <button
              onClick={() => onEdit(preset)}
              className="rounded-sm p-0.5 text-text-muted hover:bg-white/10 hover:text-text-dark"
              title={t('common.edit')}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              onClick={() => onDelete(preset)}
              className="rounded-sm p-0.5 text-text-muted hover:bg-red-500/20 hover:text-red-400"
              title={t('common.delete')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-white/60">
          <span>{cameraLabel}</span>
          <span>·</span>
          <span>{lensLabel}</span>
          <span>·</span>
          <span>{preset.focalLength}mm</span>
          <span>·</span>
          <span>f/{preset.aperture}</span>
        </div>
      </div>
      <UiButton variant="primary" size="sm" className="shrink-0" onClick={() => onApply(preset)}>
        <Check className="mr-1 h-3 w-3" />
        {t('cameraControl.preset.apply')}
      </UiButton>
    </div>
  );
});

PresetItem.displayName = 'PresetItem';

export const CameraPresetsPanel = memo(
  ({
    isOpen,
    onClose,
    currentCameraControl,
    onApply,
    openWithSaveDialog = false,
  }: CameraPresetsPanelProps) => {
    const { t } = useTranslation();
    const [presets, setPresets] = useState<CameraPreset[]>([]);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [editingPreset, setEditingPreset] = useState<CameraPreset | null>(null);
    const [deletingPreset, setDeletingPreset] = useState<CameraPreset | null>(null);
    const [page, setPage] = useState(0);

    const PAGE_SIZE = 3;

    const loadPresets = useCallback(() => {
      setPresets(getAllPresets());
    }, []);

    useEffect(() => {
      if (isOpen) {
        loadPresets();
        setPage(0);
        if (openWithSaveDialog) {
          setShowSaveDialog(true);
        }
      }
    }, [isOpen, loadPresets, openWithSaveDialog]);

    const totalPages = Math.max(1, Math.ceil(presets.length / PAGE_SIZE));
    const currentPage = Math.min(page, totalPages - 1);
    const pageItems = useMemo(
      () => presets.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
      [presets, currentPage]
    );

    const handleSave = useCallback(
      (name: string) => {
        if (currentCameraControl) {
          savePreset(name, currentCameraControl);
          loadPresets();
        }
      },
      [currentCameraControl, loadPresets]
    );

    const handleEditSave = useCallback(
      (id: string, name: string) => {
        updatePreset(id, { name });
        loadPresets();
      },
      [loadPresets]
    );

    const handleDelete = useCallback(() => {
      if (deletingPreset) {
        deletePreset(deletingPreset.id);
        loadPresets();
        setDeletingPreset(null);
      }
    }, [deletingPreset, loadPresets]);

    const handleApply = useCallback(
      (preset: CameraPreset) => {
        const cameraControl = presetToCameraControl(preset);
        onApply(cameraControl);
        onClose();
      },
      [onApply, onClose]
    );

    if (!isOpen) {
      return null;
    }

    return (
      <>
        <div
          className="fixed inset-0 z-100 flex items-center justify-center bg-black/50"
          onClick={onClose}
        >
          <UiPanel
            className="w-[640px] max-h-[82vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3.5">
              <h2 className="text-base font-semibold text-text-dark">
                {t('cameraControl.preset.myPresets')} <span className="ml-2 text-xs text-text-muted">({presets.length})</span>
              </h2>
              <button
                onClick={onClose}
                className="rounded-md p-1 text-text-muted hover:bg-bg-dark hover:text-text-dark transition-colors"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content — paginated, PAGE_SIZE cards per page */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {presets.length === 0 ? (
                <div className="py-16 text-center text-sm text-text-muted">
                  {t('cameraControl.preset.empty')}
                </div>
              ) : (
                pageItems.map((preset) => (
                  <PresetItem
                    key={preset.id}
                    preset={preset}
                    onEdit={setEditingPreset}
                    onDelete={setDeletingPreset}
                    onApply={handleApply}
                  />
                ))
              )}
            </div>

            {/* Pagination footer */}
            {presets.length > PAGE_SIZE && (
              <div className="shrink-0 flex items-center justify-center gap-3 border-t border-white/10 px-5 py-2.5">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-white/10 hover:text-text-dark disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="上一页"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-text-muted tabular-nums">
                  {currentPage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={currentPage >= totalPages - 1}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-white/10 hover:text-text-dark disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="下一页"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Footer */}
            <div className="shrink-0 flex justify-between items-center border-t border-white/10 px-5 py-3">
              <span className="text-[11px] text-text-muted">摄像机配置会保存在本机</span>
              <UiButton
                variant="primary"
                size="sm"
                onClick={() => setShowSaveDialog(true)}
                disabled={!currentCameraControl}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {t('cameraControl.preset.saveAs')}
              </UiButton>
            </div>
          </UiPanel>
        </div>

        <SavePresetDialog
          isOpen={showSaveDialog}
          onClose={() => setShowSaveDialog(false)}
          onSave={handleSave}
        />

        <EditPresetDialog
          isOpen={!!editingPreset}
          preset={editingPreset}
          onClose={() => setEditingPreset(null)}
          onSave={handleEditSave}
        />

        <DeleteConfirmDialog
          isOpen={!!deletingPreset}
          presetName={deletingPreset?.name ?? ''}
          onClose={() => setDeletingPreset(null)}
          onConfirm={handleDelete}
        />
      </>
    );
  }
);

CameraPresetsPanel.displayName = 'CameraPresetsPanel';
