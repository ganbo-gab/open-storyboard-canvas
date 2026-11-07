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
import { CAMERA_PROFILES, LENS_PROFILES } from '@/features/canvas/application/cameraPromptLibrary';
import { UiButton, UiIconButton, UiInput, UiModal } from '@/components/ui';

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
    }
  }, [isOpen]);

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed) {
      try { onSave(trimmed); onClose(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
  }, [name, onSave, onClose]);

  return (
    <UiModal
      isOpen={isOpen}
      title={t('cameraControl.preset.saveTitle')}
      onClose={onClose}
      footer={
        <>
          <UiButton variant="secondary" size="sm" onClick={onClose}>
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
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && preset) {
      setName(preset.name);
      setError(null);
    }
  }, [isOpen, preset]);

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed && preset) {
      try { onSave(preset.id, trimmed); onClose(); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    }
  }, [name, preset, onSave, onClose]);

  return (
    <UiModal
      isOpen={isOpen}
      title={t('cameraControl.preset.editTitle')}
      onClose={onClose}
      footer={
        <>
          <UiButton variant="secondary" size="sm" onClick={onClose}>
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
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
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
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { if (isOpen) setError(null); }, [isOpen]);

    return (
      <UiModal
        isOpen={isOpen}
        title={t('cameraControl.preset.deleteTitle')}
        onClose={onClose}
        footer={
          <>
            <UiButton variant="secondary" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </UiButton>
            <UiButton
              variant="destructive"
              size="sm"
              onClick={() => {
                try { onConfirm(); onClose(); }
                catch (error) { setError(error instanceof Error ? error.message : String(error)); }
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
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
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

  const cameraLabel = CAMERA_PROFILES.find((profile) => profile.id === preset.camera)?.label ?? preset.camera;
  const lensLabel = LENS_PROFILES.find((profile) => profile.id === preset.lens)?.label ?? preset.lens;

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--field-bg)] px-3 py-2 hover:border-[var(--line-strong)] transition-colors duration-[var(--dur-1)]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text-dark">{preset.name}</span>
          <div className="flex gap-0.5 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100 group-focus-within:opacity-100">
            <UiIconButton
              size="sm"
              onClick={() => onEdit(preset)}
              className="h-6 w-6"
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil className="h-3 w-3" />
            </UiIconButton>
            <UiIconButton
              size="sm"
              onClick={() => onDelete(preset)}
              className="h-6 w-6 hover:bg-danger/12 hover:text-danger"
              title={t('common.delete')}
              aria-label={t('common.delete')}
            >
              <Trash2 className="h-3 w-3" />
            </UiIconButton>
          </div>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-text-muted">
          <span>{cameraLabel}</span>
          <span>·</span>
          <span>{lensLabel}</span>
          <span>·</span>
          <span>{preset.focalLength}mm</span>
          <span>·</span>
          <span>f/{preset.aperture}</span>
        </div>
      </div>
      <UiButton
        variant="primary"
        size="sm"
        className="shrink-0"
        icon={<Check className="h-3.5 w-3.5" />}
        onClick={() => onApply(preset)}
      >
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
    const [error, setError] = useState<string | null>(null);

    const PAGE_SIZE = 3;

    const loadPresets = useCallback(() => {
      try { setPresets(getAllPresets()); setError(null); }
      catch (error) { setPresets([]); setError(error instanceof Error ? error.message : String(error)); }
    }, []);

    useEffect(() => {
      if (isOpen) {
        loadPresets();
        setPage(0);
        setShowSaveDialog(openWithSaveDialog);
      } else {
        setShowSaveDialog(false);
        setEditingPreset(null);
        setDeletingPreset(null);
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
        <UiModal isOpen={isOpen} title={t('cameraControl.preset.myPresets')} onClose={onClose} widthClassName="w-[640px]"
          description={`共 ${presets.length} 个预设，保存在本机；载入后可继续调整，点击摄像机面板的应用才更新生成设置。`}
          footer={<><UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</UiButton>
            <UiButton variant="primary" size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={() => setShowSaveDialog(true)} disabled={!currentCameraControl}>{t('cameraControl.preset.saveAs')}</UiButton></>}>
            {/* Content — paginated, PAGE_SIZE cards per page */}
            {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
            <div className="space-y-3 py-1">
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
              <div className="shrink-0 flex items-center justify-center gap-3 border-t border-[var(--line)] px-5 py-2.5">
                <UiIconButton
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  aria-label="上一页"
                >
                  <ChevronLeft className="h-4 w-4" />
                </UiIconButton>
                <span className="text-xs text-text-muted tabular-nums">
                  {currentPage + 1} / {totalPages}
                </span>
                <UiIconButton
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={currentPage >= totalPages - 1}
                  aria-label="下一页"
                >
                  <ChevronRight className="h-4 w-4" />
                </UiIconButton>
              </div>
            )}

        </UiModal>

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
