import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { NodeProps } from '@xyflow/react';

interface NodeRenderErrorBoundaryProps {
  nodeId: string;
  children: ReactNode;
}

interface NodeRenderErrorBoundaryState {
  error: Error | null;
}

class NodeRenderErrorBoundary extends Component<
  NodeRenderErrorBoundaryProps,
  NodeRenderErrorBoundaryState
> {
  state: NodeRenderErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): NodeRenderErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(previousProps: NodeRenderErrorBoundaryProps): void {
    if (previousProps.nodeId !== this.props.nodeId && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[NodeRenderErrorBoundary] Canvas node render failed', {
      nodeId: this.props.nodeId,
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="w-[360px] rounded-xl border border-red-400/30 bg-[var(--canvas-node-bg)] p-3 text-xs leading-5 text-text-dark shadow-lg">
        <div className="mb-1 font-semibold text-red-200">节点渲染失败</div>
        <div className="text-text-muted">这个节点的数据触发了渲染异常，画布已继续加载。</div>
        <pre className="ui-scrollbar mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--canvas-node-border)] bg-bg-dark/70 p-2 text-[11px]">
          {this.state.error.message}
        </pre>
      </div>
    );
  }
}

export function withNodeRenderErrorBoundary<TProps extends { id: string | number }>(
  NodeComponent: ComponentType<TProps>
): ComponentType<NodeProps> {
  function SafeNode(props: TProps) {
    return (
      <NodeRenderErrorBoundary nodeId={String(props.id)}>
        <NodeComponent {...props} />
      </NodeRenderErrorBoundary>
    );
  }

  SafeNode.displayName = `Safe${NodeComponent.displayName || NodeComponent.name || 'CanvasNode'}`;
  return SafeNode as unknown as ComponentType<NodeProps>;
}
