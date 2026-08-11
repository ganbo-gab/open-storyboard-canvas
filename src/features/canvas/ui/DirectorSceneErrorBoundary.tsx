import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      <div className="flex h-full items-center justify-center bg-[#071012] p-6 text-white">
        <div className="w-full max-w-lg rounded-xl border border-red-300/20 bg-[#111719]/96 p-5 shadow-2xl">
          <div className="text-sm font-semibold text-red-100">{this.props.title}</div>
          <p className="mt-2 text-xs leading-5 text-white/58">{this.props.description}</p>
          <pre className="ui-scrollbar mt-3 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/24 p-3 text-[11px] leading-5 text-white/48">
            {error.message}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={this.props.onClose}
              className="rounded-md border border-white/12 bg-white/6 px-3 py-2 text-xs text-white/68 transition-colors hover:bg-white/10 hover:text-white"
            >
              {this.props.closeLabel}
            </button>
            <button
              type="button"
              onClick={() => this.props.onRetry(error)}
              className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent/90"
            >
              {this.props.retryLabel}
            </button>
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
