import { z } from 'zod';
import type { ComfyUITransport } from '@/features/canvas/infrastructure/comfyuiGateway';

const bytes = z.number().finite().nonnegative().optional();
const deviceSchema = z.object({ name: z.string().optional(), type: z.string().optional(), index: z.number().int().nonnegative().optional(),
  vram_total: bytes, vram_free: bytes, torch_vram_total: bytes, torch_vram_free: bytes });
const systemStatsSchema = z.object({
  system: z.object({ comfyui_version: z.string().optional(), version: z.string().optional(), os: z.string().optional(), python_version: z.string().optional() }).optional(),
  devices: z.array(deviceSchema).optional(),
});
const queueSchema = z.object({ queue_running: z.array(z.unknown()), queue_pending: z.array(z.unknown()) });
export interface ComfyUIConnectionStats {
  checkedAt: number;
  reachable: boolean;
  status: 'idle' | 'queued' | 'running' | 'unknown' | 'unreachable';
  system?: { version?: string; os?: string; pythonVersion?: string; devices?: z.infer<typeof deviceSchema>[] };
  queue?: { running: number; pending: number };
  errors: { systemStats?: string; queue?: string };
}

/** Read-only control plane. Missing counters/devices stay unknown; no generation or GPU probe is performed. */
export async function inspectComfyUIConnection(transport: Pick<ComfyUITransport, 'json'>): Promise<ComfyUIConnectionStats> {
  const [statsResult, queueResult] = await Promise.allSettled([
    transport.json('/system_stats', 'GET'), transport.json('/queue', 'GET'),
  ]);
  const result: ComfyUIConnectionStats = { checkedAt: Date.now(), reachable: statsResult.status === 'fulfilled' || queueResult.status === 'fulfilled', status: 'unknown', errors: {} };
  if (!result.reachable) result.status = 'unreachable';
  if (statsResult.status === 'fulfilled') {
    const parsed = systemStatsSchema.safeParse(statsResult.value);
    if (parsed.success && (parsed.data.system || parsed.data.devices)) {
      const { system, devices } = parsed.data;
      result.system = { ...(system?.comfyui_version ?? system?.version ? { version: system?.comfyui_version ?? system?.version } : {}),
        ...(system?.os ? { os: system.os } : {}), ...(system?.python_version ? { pythonVersion: system.python_version } : {}),
        ...(devices ? { devices } : {}) };
    } else result.errors.systemStats = 'ComfyUI /system_stats did not return valid system statistics';
  } else result.errors.systemStats = statsResult.reason instanceof Error ? statsResult.reason.message : 'ComfyUI /system_stats request failed';
  if (queueResult.status === 'fulfilled') {
    const parsed = queueSchema.safeParse(queueResult.value);
    if (parsed.success) {
      result.queue = { running: parsed.data.queue_running.length, pending: parsed.data.queue_pending.length };
      result.status = result.queue.running > 0 ? 'running' : result.queue.pending > 0 ? 'queued' : 'idle';
    } else result.errors.queue = 'ComfyUI /queue did not return valid queue statistics';
  } else result.errors.queue = queueResult.reason instanceof Error ? queueResult.reason.message : 'ComfyUI /queue request failed';
  return result;
}
