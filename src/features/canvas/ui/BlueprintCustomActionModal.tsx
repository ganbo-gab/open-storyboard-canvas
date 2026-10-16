import { memo, useCallback, useState } from 'react';
import { CheckCircle2, Copy, Sparkles, X } from 'lucide-react';

import type { BlueprintActionPose } from '@/features/canvas/domain/canvasNodes';
import { BlueprintPoseEditor } from './BlueprintPoseEditor';
import { BlueprintPosePreview } from './BlueprintPosePreview';
import { buildBlueprintPosePrompt, parseBlueprintPoseJson } from './blueprintPosePromptUtils';

/**
 * Modal for designing a new person-action preset. The legacy "命令" text
 * field has been retired (it never produced any visual change in the
 * scene). What remains is geared toward actually shaping the pose:
 *
 * - Live 3D preview on the right that mirrors the slider state in real
 *   time so users see exactly what each tweak does.
 * - Pose editor (bone rotation sliders) below the preview.
 * - AI-assist column on the left: a textarea for the action description,
 *   a "复制提示词" button that drops a structured prompt into the
 *   clipboard, and a "粘贴 AI 返回 + 一键导入" pair so users can ship
 *   the prompt to ChatGPT / Claude and bring the result straight back
 *   into the pose without manually wiring 13 sliders.
 *
 * The form is fully controlled — the parent owns name / pose state and
 * the modal owns transient inputs (description, AI response textarea,
 * import error toasts).
 */
export interface BlueprintCustomActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  nameValue: string;
  poseValue: BlueprintActionPose;
  onNameChange: (next: string) => void;
  onPoseChange: (next: BlueprintActionPose) => void;
  onSave: () => void;
}

export const BlueprintCustomActionModal = memo(function BlueprintCustomActionModal(props: BlueprintCustomActionModalProps) {
  const { isOpen, onClose, nameValue, poseValue, onNameChange, onPoseChange, onSave } = props;
  const [description, setDescription] = useState('');
  const [importDraft, setImportDraft] = useState('');
  const [importMessage, setImportMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);

  const handleCopyPrompt = useCallback(async () => {
    const prompt = buildBlueprintPosePrompt(nameValue, description);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1400);
    } catch {
      // Clipboard API can fail in non-secure contexts. Fall back to a textarea
      // selection so the user can still grab the text manually.
      setImportMessage({
        kind: 'error',
        text: '剪贴板不可用，请手动复制下方提示词输入框（如有）。',
      });
    }
  }, [description, nameValue]);

  const handleImport = useCallback(() => {
    const result = parseBlueprintPoseJson(importDraft);
    if (result.error || !result.pose) {
      setImportMessage({ kind: 'error', text: result.error ?? '无法解析的 JSON。' });
      return;
    }
    onPoseChange(result.pose);
    setImportMessage({ kind: 'ok', text: '已导入姿态参数，可继续微调。' });
  }, [importDraft, onPoseChange]);

  if (!isOpen) return null;

  return (
    <div
      className="absolute inset-0 z-270 flex items-center justify-center bg-black/55 backdrop-blur-xs"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="nodrag nopan w-[840px] max-w-[calc(100%-32px)] rounded-xl border border-white/14 bg-[#181818] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-white">自定义动作 · 姿态编辑器</div>
            <div className="mt-0.5 text-[11px] text-white/42">
              用左侧 AI 提示词或右侧手动滑块设计姿态，预览图实时反映效果
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_240px_minmax(0,1.2fr)] gap-3 px-4 py-3">
          {/* ─── Column 1: name + AI assist ───────────────────────────────── */}
          <div className="space-y-3">
            <label className="block text-[11px] text-white/55">
              动作名称
              <input
                value={nameValue}
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="例如：递出文件 / 张开双臂"
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs text-white/85 outline-hidden placeholder:text-white/28 focus:border-white/25"
              />
            </label>
            <label className="block text-[11px] text-white/55">
              动作描述（仅用于生成提示词）
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="角色的整体姿态、肢体方向、表情细节，可直接写情境，例如：左手掌心朝上托物，右手指向远处，目视前方稍仰头"
                rows={5}
                className="nodrag nowheel mt-1 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs text-white/85 outline-hidden placeholder:text-white/28 focus:border-white/25"
              />
            </label>

            <div className="rounded-lg border border-white/10 bg-black/18 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-white/65">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                <span className="font-semibold">AI 协助</span>
              </div>
              <p className="mb-2 text-[10px] leading-4 text-white/45">
                复制提示词去 ChatGPT / Claude，把返回的 JSON 粘贴回这里点「一键导入」即可应用到姿态。
              </p>
              <button
                type="button"
                onClick={handleCopyPrompt}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-white/12 px-2 py-2 text-[11px] text-white/85 hover:bg-white/20"
              >
                {copyFlash ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copyFlash ? '已复制' : '复制提示词到剪贴板'}
              </button>
              <textarea
                value={importDraft}
                onChange={(event) => {
                  setImportDraft(event.target.value);
                  if (importMessage) setImportMessage(null);
                }}
                placeholder="粘贴 AI 返回的 JSON …"
                rows={4}
                className="nodrag nowheel mt-2 w-full resize-none rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white/85 outline-hidden placeholder:text-white/28 focus:border-white/25"
              />
              <button
                type="button"
                onClick={handleImport}
                className="mt-2 w-full rounded-md bg-accent px-2 py-2 text-[11px] font-semibold text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!importDraft.trim()}
              >
                一键导入
              </button>
              {importMessage && (
                <div
                  className={`mt-2 rounded-md px-2 py-1.5 text-[10px] leading-4 ${
                    importMessage.kind === 'ok'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-red-500/15 text-red-300'
                  }`}
                >
                  {importMessage.text}
                </div>
              )}
            </div>
          </div>

          {/* ─── Column 2: live preview ─────────────────────────────────── */}
          <div className="flex flex-col items-center gap-2">
            <div className="text-[11px] font-semibold text-white/65">实时预览</div>
            <BlueprintPosePreview pose={poseValue} />
            <div className="text-[10px] text-white/35">缓慢自转，便于观察各角度</div>
          </div>

          {/* ─── Column 3: pose editor sliders ─────────────────────────── */}
          <BlueprintPoseEditor pose={poseValue} onChange={onPoseChange} />
        </div>

        <div className="flex items-center justify-between border-t border-white/8 px-4 py-3">
          <div className="text-[10px] text-white/35">
            提示：保存后会自动应用到当前选中的人物，可在右栏动作预设里再次点击复用。
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-white/8 px-3 py-1.5 text-xs text-white/75 hover:bg-white/14"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-gray-100"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
