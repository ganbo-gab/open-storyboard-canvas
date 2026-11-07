// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type TextAnnotationNodeData } from '@/features/canvas/domain/canvasNodes';
import { usePromptDraft } from '@/features/canvas/composer/usePromptDraft';

vi.mock('@/features/canvas/ui/NodeFrame', () => ({ NodeFrame: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/features/canvas/ui/TextPreviewModal', () => ({ TextPreviewModal: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { TextAnnotationNode } from './TextAnnotationNode';

function Note() {
  const node = useCanvasStore((state) => state.nodes[0]);
  return <TextAnnotationNode id={node.id} data={node.data as TextAnnotationNodeData} type={node.type} selected dragging={false} zIndex={0} selectable deletable draggable isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
function Prompt() {
  const committed = useCanvasStore((state) => String(state.nodes[0].data.prompt ?? ''));
  const draft = usePromptDraft('note', 'prompt', committed);
  return <textarea aria-label="Prompt" value={draft.value} onChange={(event) => draft.set(event.target.value)} onBlur={() => draft.flush()} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  useCanvasStore.setState({ nodes: [{ id: 'note', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'Start', prompt: 'Start' } }], edges: [], revision: 0, selectedNodeId: null, history: { past: [], future: [] }, dragHistorySnapshot: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('text edit history commit timing', () => {
  it('coalesces annotation typing into one undo entry after a full 1s pause', () => {
    render(<Note />);
    fireEvent.doubleClick(screen.getByText('Start'));
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'First' } });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.change(editor, { target: { value: 'Second' } });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.change(editor, { target: { value: 'Final' } });
    act(() => vi.advanceTimersByTime(999));
    expect((editor as HTMLTextAreaElement).value).toBe('Final');
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Start');
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Final');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    act(() => { useCanvasStore.getState().undo(); });
    expect((editor as HTMLTextAreaElement).value).toBe('Start');
    act(() => { useCanvasStore.getState().redo(); });
    expect((editor as HTMLTextAreaElement).value).toBe('Final');
  });

  it('flushes annotation drafts on blur and unmount without a duplicate timer entry', () => {
    const view = render(<Note />);
    fireEvent.doubleClick(screen.getByText('Start'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Blurred' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Blurred');
    act(() => vi.advanceTimersByTime(1000));
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    fireEvent.doubleClick(screen.getByText('Blurred'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unmounted' } });
    view.unmount();
    expect(useCanvasStore.getState().nodes[0].data.content).toBe('Unmounted');
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
  });

  it('coalesces prompt drafts at 1s and flushes the latest prompt before leaving', () => {
    render(<Prompt />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prompt one' } });
    act(() => vi.advanceTimersByTime(700));
    expect(useCanvasStore.getState().nodes[0].data.prompt).toBe('Start');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prompt two' } });
    act(() => vi.advanceTimersByTime(999));
    expect(useCanvasStore.getState().history.past).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(useCanvasStore.getState().nodes[0].data.prompt).toBe('Prompt two');
    expect(useCanvasStore.getState().history.past).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Prompt three' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(useCanvasStore.getState().nodes[0].data.prompt).toBe('Prompt three');
    expect(useCanvasStore.getState().history.past).toHaveLength(2);
  });
});
