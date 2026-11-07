import { afterEach, describe, expect, it } from 'vitest';
import { usePanelStateStore, type PanelAnchor } from './panelStateStore';

const anchor = (nodeId: string, buttonKey: PanelAnchor['buttonKey'] = 'gridSplit'): PanelAnchor => ({ nodeId, buttonKey,
  fallbackRect: { x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20, toJSON: () => ({}) } });
afterEach(() => usePanelStateStore.getState().closeAllPanels());

describe('canvas tool panel selection', () => {
  it('closes a click-opened panel when its same node and tool are clicked again', () => {
    const store = usePanelStateStore.getState();
    store.openPanel('gridSplit', anchor('node'));
    expect(usePanelStateStore.getState()).toMatchObject({ isOpen: true, type: 'gridSplit', openMode: 'click', anchor: { nodeId: 'node' } });
    usePanelStateStore.getState().setPointerOverPanel(true);
    store.openPanel('gridSplit', anchor('node'));
    expect(usePanelStateStore.getState()).toMatchObject({ isOpen: false, type: null, anchor: null, openMode: null, isPointerOverPanel: false });
  });

  it('pins a hover panel on click and ignores later hover requests until the click-pinned panel is closed', () => {
    const store = usePanelStateStore.getState();
    store.openPanel('gridSplit', anchor('node'), 'hover');
    store.openPanel('gridSplit', anchor('node'), 'click');
    expect(usePanelStateStore.getState()).toMatchObject({ isOpen: true, type: 'gridSplit', openMode: 'click' });
    const pinned = usePanelStateStore.getState();
    store.openPanel('lighting', anchor('other-node', 'lighting'), 'hover');
    expect(usePanelStateStore.getState()).toBe(pinned);
    store.openPanel('gridSplit', anchor('node'), 'click');
    expect(usePanelStateStore.getState().isOpen).toBe(false);
  });

  it('switches to another node or tool with one click instead of treating it as a close toggle', () => {
    const store = usePanelStateStore.getState();
    store.openPanel('gridSplit', anchor('first'));
    store.openPanel('gridSplit', anchor('second'));
    expect(usePanelStateStore.getState()).toMatchObject({ isOpen: true, type: 'gridSplit', anchor: { nodeId: 'second' } });
    store.openPanel('lighting', anchor('second', 'lighting'));
    expect(usePanelStateStore.getState()).toMatchObject({ isOpen: true, type: 'lighting', anchor: { nodeId: 'second' }, openMode: 'click' });
  });
});
