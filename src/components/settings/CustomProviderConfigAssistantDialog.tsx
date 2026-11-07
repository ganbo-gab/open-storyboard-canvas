import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Clipboard, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiModal, UiSelect, UiTextArea } from '@/components/ui/primitives';
import { useChatModelCatalog } from '@/features/canvas/application/chatModelCatalog';
import {
  CUSTOM_PROVIDER_TUTORIAL_PROMPT,
  buildCustomImageProviderAssistantMessages,
  parseCustomImageProviderAssistantResponse,
  sanitizeProviderDocumentationForAi,
} from '@/features/canvas/application/customImageProviderAiPrompt';
import type { CustomImageProviderDraft } from '@/features/canvas/application/customImageProviderConfig';
import { submitCustomChatCompletion } from '@/features/channels/runtime/channelChat';

interface CustomProviderConfigAssistantDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onApply: (draft: CustomImageProviderDraft) => void;
}

function formatIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.slice(0, 8).map((entry) => `${entry.path}: ${entry.message}`).join('\n');
}

export function CustomProviderConfigAssistantDialog({
  isOpen,
  onClose,
  onApply,
}: CustomProviderConfigAssistantDialogProps) {
  const { t } = useTranslation();
  const catalog = useChatModelCatalog();
  const usableCatalog = useMemo(() => catalog.filter((entry) => entry.usable), [catalog]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [documentation, setDocumentation] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [generated, setGenerated] = useState(false);
  const showExternalFallback = usableCatalog.length === 0 || Boolean(error);

  useEffect(() => {
    if (!isOpen) return;
    if (!usableCatalog.some((entry) => entry.id === selectedModelId)) {
      setSelectedModelId(usableCatalog[0]?.id ?? '');
    }
    setError('');
    setGenerated(false);
  }, [isOpen, selectedModelId, usableCatalog]);

  const applyJsonText = (text: string): boolean => {
    try {
      const parsed = parseCustomImageProviderAssistantResponse(text);
      if (!parsed.value || parsed.issues.length > 0) {
        setError(formatIssues(parsed.issues));
        return false;
      }
      onApply(parsed.value);
      setGenerated(true);
      setError('');
      return true;
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
      return false;
    }
  };

  const handleGenerate = async () => {
    if (!selectedModelId) {
      setError(t('settings.customProviders.assistant.noUsableModel'));
      return;
    }
    setLoading(true);
    setError('');
    setGenerated(false);
    try {
      const messages = buildCustomImageProviderAssistantMessages(documentation);
      const result = await submitCustomChatCompletion(selectedModelId, {
        messages,
        temperature: 0,
        max_tokens: 6000,
        stream: false,
      });
      const safeResponse = sanitizeProviderDocumentationForAi(result.text).slice(0, 24_000);
      setJsonText(safeResponse);
      applyJsonText(safeResponse);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : String(generationError));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(CUSTOM_PROVIDER_TUTORIAL_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  return (
    <UiModal
      isOpen={isOpen}
      title={t('settings.customProviders.assistant.title')}
      onClose={onClose}
      widthClassName="w-[min(94vw,820px)]"
      containerClassName="py-5"
      footer={
        <>
          {showExternalFallback && (
            <UiButton type="button" variant="ghost" size="sm" onClick={handleCopyPrompt}>
              {copied ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <Clipboard className="mr-1.5 h-3.5 w-3.5" />}
              {copied
                ? t('settings.customProviders.assistant.promptCopied')
                : t('settings.customProviders.assistant.copyExternalPrompt')}
            </UiButton>
          )}
          <div className="ml-auto flex gap-2">
            <UiButton type="button" variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </UiButton>
            {showExternalFallback && (
              <UiButton
                type="button"
                variant="primary"
                size="sm"
                disabled={!jsonText.trim() || loading}
                onClick={() => applyJsonText(jsonText)}
              >
                {t('settings.customProviders.assistant.applyJson')}
              </UiButton>
            )}
          </div>
        </>
      }
    >
      <div className="ui-scrollbar max-h-[72vh] space-y-4 overflow-y-auto pr-1">
        <div className="rounded-lg border border-accent/25 bg-accent/5 p-3 text-xs leading-5 text-text-muted">
          <div className="flex items-center gap-2 font-medium text-text-dark">
            <Bot className="h-4 w-4 text-accent" />
            {t('settings.customProviders.assistant.securityTitle')}
          </div>
          <p className="mt-1">{t('settings.customProviders.assistant.securityDescription')}</p>
        </div>

        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.assistant.model')}
          <UiSelect
            className="mt-2 h-9 text-sm"
            value={selectedModelId}
            onChange={(event) => setSelectedModelId(event.target.value)}
          >
            <option value="">{t('settings.customProviders.assistant.selectModel')}</option>
            {catalog.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.usable}>
                {entry.providerLabel} · {entry.modelLabel}{entry.usable ? '' : ` — ${entry.notReadyReason ?? ''}`}
              </option>
            ))}
          </UiSelect>
          {usableCatalog.length === 0 && (
            <span className="mt-2 block text-[11px] leading-5 text-warning">
              {t('settings.customProviders.assistant.noUsableModelHelp')}
            </span>
          )}
        </label>

        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.assistant.documentation')}
          <UiTextArea
            className="mt-2 h-40 font-mono text-xs"
            value={documentation}
            onChange={(event) => setDocumentation(event.target.value)}
            placeholder={t('settings.customProviders.assistant.documentationPlaceholder')}
          />
        </label>

        <div className="flex justify-end">
          <UiButton
            type="button"
            variant="primary"
            size="sm"
            loading={loading}
            icon={<Sparkles />}
            disabled={!selectedModelId || !documentation.trim()}
            onClick={() => { void handleGenerate(); }}
          >
            {loading
              ? t('settings.customProviders.assistant.generating')
              : t('settings.customProviders.assistant.generate')}
          </UiButton>
        </div>

        {showExternalFallback && (
          <div className="rounded-lg border border-warning/25 bg-warning/8 p-3">
            <div className="text-xs font-medium text-warning">
              {t('settings.customProviders.assistant.fallbackTitle')}
            </div>
            <p className="mt-1 text-[11px] leading-5 text-text-muted">
              {t('settings.customProviders.assistant.fallbackDescription')}
            </p>
            <label className="mt-3 block text-xs font-medium text-text-muted">
              {t('settings.customProviders.assistant.jsonDraft')}
              <UiTextArea
                className="mt-2 h-56 font-mono text-xs"
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setGenerated(false);
                }}
                placeholder={t('settings.customProviders.assistant.jsonPlaceholder')}
              />
            </label>
          </div>
        )}

        {generated && (
          <div className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('settings.customProviders.assistant.appliedNotice')}
          </div>
        )}
        {error && (
          <pre className="whitespace-pre-wrap rounded-lg border border-danger/25 bg-danger/8 p-3 text-[11px] leading-5 text-danger">
            {error}
          </pre>
        )}
      </div>
    </UiModal>
  );
}
