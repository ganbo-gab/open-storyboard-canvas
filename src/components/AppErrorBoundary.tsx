import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

function formatErrorDetails(error: Error, errorInfo: ErrorInfo | null): string {
  return [
    error.stack || `${error.name}: ${error.message}`,
    errorInfo?.componentStack ? `Component stack:${errorInfo.componentStack}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    errorInfo: null,
  };

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('[AppErrorBoundary] React render failed', error, errorInfo);
  }

  render() {
    const { error, errorInfo } = this.state;
    if (!error) {
      return this.props.children;
    }

    const details = formatErrorDetails(error, errorInfo);

    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-dark p-6 text-text-dark">
        <div className="max-w-3xl rounded-xl border border-red-400/25 bg-surface-dark p-5 shadow-2xl">
          <div className="mb-2 text-base font-semibold text-red-200">页面渲染失败</div>
          <div className="mb-4 text-sm leading-6 text-text-muted">
            软件没有卡死，是前端渲染遇到了异常。下面的信息可以用来定位黑屏原因。
          </div>
          <pre className="ui-scrollbar max-h-[50vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--canvas-node-border) bg-bg-dark/70 p-3 text-xs leading-5 text-text-dark">
            {details}
          </pre>
        </div>
      </div>
    );
  }
}
