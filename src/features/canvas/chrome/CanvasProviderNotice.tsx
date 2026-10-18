import { useMemo } from 'react';

import { hasConfiguredAnyProvider } from '@/features/canvas/application/providerAvailability';
import { listModelProviders } from '@/features/canvas/models';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCustomProvidersStore } from '@/stores/customProvidersStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Shown once the canvas has content but no channel can run a generation. */
export function CanvasProviderNotice() {
  const hasNodes = useCanvasStore((state) => state.nodes.length > 0);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const dreaminaStatus = useSettingsStore((state) => state.dreaminaStatus);
  const agnesApiKey = useSettingsStore((state) => state.agnesApiKey);
  const customProviders = useCustomProvidersStore((state) => state.providers);
  const configured = useMemo(() => hasConfiguredAnyProvider({
    apiKeys,
    builtInProviderIds: listModelProviders().map((provider) => provider.id),
    customProviders,
    dreaminaStatus,
    agnesApiKey,
  }), [agnesApiKey, apiKeys, customProviders, dreaminaStatus]);

  if (!hasNodes || configured) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2" data-canvas-overlay="">
      <MissingApiKeyHint />
    </div>
  );
}
