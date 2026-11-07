import type { ImageOutputGeometryDiagnostic } from '@/features/canvas/application/imageOutputGeometry';

export interface CustomProviderRequestDebugPreview {
  providerLabel: string;
  providerId: string;
  modelId: string;
  modelName: string;
  method: 'GET' | 'POST';
  bodyMode: 'json' | 'multipart' | 'form-urlencoded' | 'none';
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  body?: unknown;
  multipart?: unknown;
  imageOutputDiagnostic?: ImageOutputGeometryDiagnostic;
  error?: string;
}
export interface CustomProviderTestResult {
  ok: boolean;
  status?: number;
  imageUrl?: string;
  text?: string;
  errorMessage?: string;
  rawPreview?: string;
}
export interface CustomProviderModelListResult {
  ok: boolean;
  models: string[];
  status?: number;
  errorMessage?: string;
  rawPreview?: string;
}
