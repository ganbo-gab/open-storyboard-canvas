import { ReactFlowProvider } from '@xyflow/react';

import { Canvas } from './Canvas';
import { CanvasTopBar } from './ui/CanvasTopBar';
import { CanvasAgentDock } from './agent/ui/CanvasAgentDock';

interface CanvasWorkspaceProps {
  projectId: string;
}

export function CanvasWorkspace({ projectId }: CanvasWorkspaceProps) {
  return (
    <ReactFlowProvider>
      <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Canvas />
          <CanvasTopBar />
        </div>
        <CanvasAgentDock projectId={projectId} />
      </div>
    </ReactFlowProvider>
  );
}
