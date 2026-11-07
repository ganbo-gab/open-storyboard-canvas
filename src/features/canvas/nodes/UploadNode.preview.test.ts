// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { isUploadNode } from '@/features/canvas/domain/canvasNodes';
import { loadImageElement, prepareNodeImageFromFile, type PreparedNodeImage } from '@/features/canvas/application/imageData';
import type { CanvasImageThumbnailInput } from '@/features/canvas/application/useCanvasImageThumbnail';
import type * as ImageDataModule from '@/features/canvas/application/imageData';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/canvas/ui/NodeFrame', () => ({ NodeFrame: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/features/canvas/application/imageData', async (importOriginal) => ({
  ...await importOriginal<typeof ImageDataModule>(),
  prepareNodeImageFromFile: vi.fn(),
  loadImageElement: vi.fn(),
}));
vi.mock('@/features/canvas/application/useCanvasImageThumbnail', () => ({
  useCanvasImageThumbnail: ({ imageUrl }: CanvasImageThumbnailInput) => ({ src: imageUrl ? `blob:thumbnail:${imageUrl}` : '', fallbackSrcs: [], viewerSrc: imageUrl ?? '', pending: !imageUrl }),
}));
import { UploadNode } from './UploadNode';

let prepares: Array<PromiseWithResolvers<PreparedNodeImage>>;
let decodes: Array<PromiseWithResolvers<void> & { source: string }>;
let created = 0;
const revoke = vi.fn();
const NativeURL = URL;

function Host() {
  const data = useCanvasStore((state) => {
    const node = state.nodes[0];
    if (!node || !isUploadNode(node)) throw new Error('Upload fixture is missing');
    return node.data;
  });
  return createElement(UploadNode, { id: 'upload', type: 'uploadNode', data, selected: true, width: 320, height: 320, dragging: false, zIndex: 0, selectable: true, deletable: true, draggable: true, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0 });
}
function mount() {
  const mounted = render(createElement(ReactFlowProvider, null, createElement(Host)));
  const input = mounted.container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('File input is missing');
  return { ...mounted, input };
}
function choose(input: HTMLInputElement, name: string) {
  fireEvent.change(input, { target: { files: [new File(['fixture'], name, { type: 'image/png' })] } });
}
function visibleSource(container: HTMLElement) {
  return container.querySelector('img')?.getAttribute('src');
}
async function prepared(index: number, name: string) {
  await act(async () => prepares[index].resolve({ imageUrl: `/stored/${name}.png`, previewImageUrl: `/stored/${name}-preview.png`, aspectRatio: '1:1' }));
}

beforeEach(() => {
  prepares = []; decodes = []; created = 0; revoke.mockClear();
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return `blob:instant-${++created}`; }
    static revokeObjectURL(source: string) { revoke(source); }
  });
  vi.mocked(prepareNodeImageFromFile).mockImplementation(() => {
    const pending = Promise.withResolvers<PreparedNodeImage>(); prepares.push(pending); return pending.promise;
  });
  vi.mocked(loadImageElement).mockImplementation(async source => {
    const pending = Promise.withResolvers<void>(); decodes.push({ ...pending, source });
    const image = document.createElement('img'); image.src = source; image.decode = () => pending.promise; return image;
  });
  useCanvasStore.getState().setCanvasData([{ id: 'upload', type: 'uploadNode', position: { x: 0, y: 0 }, data: { imageUrl: null, aspectRatio: '1:1' } }], []);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('temporary upload preview ownership', () => {
  it('hands off to decoded thumbnail pixels instead of retaining a full-resolution blob forever', async () => {
    const mounted = mount();
    choose(mounted.input, 'first.png');
    expect(visibleSource(mounted.container)).toBe('blob:instant-1');
    await prepared(0, 'first');
    expect(visibleSource(mounted.container)).toBe('blob:instant-1');
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => decodes[0].resolve());
    expect(visibleSource(mounted.container)).toBe('blob:thumbnail:/stored/first.png');
    expect(revoke.mock.calls).toEqual([['blob:instant-1']]);
    expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe('/stored/first.png');
  });

  it('revokes the preview on unmount while still allowing the current upload to commit', async () => {
    const mounted = mount();
    choose(mounted.input, 'first.png');
    mounted.unmount();
    expect(revoke.mock.calls).toEqual([['blob:instant-1']]);
    await prepared(0, 'first');
    expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe('/stored/first.png');
  });

  it('does not let an older import overwrite the newer file or clear its preview', async () => {
    const mounted = mount();
    choose(mounted.input, 'first.png');
    choose(mounted.input, 'second.png');
    await prepared(0, 'first');
    expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBeNull();
    expect(visibleSource(mounted.container)).toBe('blob:instant-2');
    expect(decodes).toHaveLength(0);
    await prepared(1, 'second');
    await act(async () => decodes[0].resolve());
    expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe('/stored/second.png');
    expect(visibleSource(mounted.container)).toBe('blob:thumbnail:/stored/second.png');
  });

  it('does not revoke the new preview when an older thumbnail decode finishes late', async () => {
    const mounted = mount();
    choose(mounted.input, 'first.png');
    await prepared(0, 'first');
    choose(mounted.input, 'second.png');
    await act(async () => decodes[0].resolve());
    expect(visibleSource(mounted.container)).toBe('blob:instant-2');
    expect(revoke.mock.calls).toEqual([['blob:instant-1']]);
    await prepared(1, 'second');
    await act(async () => decodes[1].resolve());
    expect(visibleSource(mounted.container)).toBe('blob:thumbnail:/stored/second.png');
    expect(revoke.mock.calls).toEqual([['blob:instant-1'], ['blob:instant-2']]);
  });
});
