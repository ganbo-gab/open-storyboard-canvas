import { Component, type ErrorInfo, type ReactNode } from 'react';
import { UiButton } from '@/components/ui';

interface DirectorSceneErrorBoundaryProps {
  children: ReactNode;
  title: string;
  description: string;
  retryLabel: string;
  closeLabel: string;
  onRetry: (error: Error) => void;
  onClose: () => void;
}

interface DirectorSceneErrorBoundaryState {
  error: Error | null;
}

export class DirectorSceneErrorBoundary extends Component<
  DirectorSceneErrorBoundaryProps,
  DirectorSceneErrorBoundaryState
> {
  state: DirectorSceneErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DirectorSceneErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[DirectorSceneErrorBoundary] Director Studio scene render failed', {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-surface p-6 text-text-dark">
        <div className="w-full max-w-lg rounded-xl border border-[var(--line)] bg-elevated p-5 shadow-[var(--shadow-pop)]">
          <div className="text-sm font-semibold text-danger">{this.props.title}</div>
          <p className="mt-2 text-xs leading-5 text-text-muted">{this.props.description}</p>
          <pre className="ui-scrollbar mt-3 max-h-28 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-[var(--line)] bg-[var(--field-bg)] p-3 text-[11px] leading-5 text-text-subtle">
            {error.message}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <UiButton variant="secondary" size="sm"
              type="button"
              onClick={this.props.onClose}
              className="rounded-md px-3 py-2 text-xs"
            >
              {this.props.closeLabel}
            </UiButton>
            <UiButton variant="primary" size="sm"
              type="button"
              onClick={() => this.props.onRetry(error)}
              className="rounded-md px-3 py-2 text-xs font-medium"
            >
              {this.props.retryLabel}
            </UiButton>
          </div>
        </div>
      </div>
    );
  }
}

export function isDirectorSceneModuleLoadError(error: Error): boolean {
  return /(?:dynamically imported module|chunkloaderror|loading chunk|importing a module script failed)/i
    .test(`${error.name}: ${error.message}`);
}
