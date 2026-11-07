// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StageOutliner } from './StageOutliner';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('separates object visibility and lock from labels and sends modifier selection', () => {
  const item = { id: 'person', label: 'Actor', x: 0, y: 0, color: '#fff', category: 'person' as const, showLabel: false };
  const select = vi.fn(); const hide = vi.fn(); const lock = vi.fn();
  render(<StageOutliner entries={[{ item, category: 'person' }]} selectedItemId="person" selectedItemIds={['person']} target="scene" showCamera={false} cameraKeyCount={0}
    onSelectTarget={vi.fn()} onSelectItem={select} onRename={vi.fn()} onToggleHidden={hide} onToggleLocked={lock} />);
  fireEvent.click(screen.getByText('Actor'), { shiftKey: true }); expect(select).toHaveBeenCalledWith('person', true);
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.selection.hide' })); expect(hide).toHaveBeenCalledWith(item);
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.selection.lock' })); expect(lock).toHaveBeenCalledWith(item);
});
it('keeps locked objects selectable in the outliner and only offers unlock', () => {
  const item = { id: 'locked', label: 'Locked actor', x: 0, y: 0, color: '#fff', category: 'person' as const, locked: true, hidden: true };
  const select = vi.fn(); const unlock = vi.fn();
  render(<StageOutliner entries={[{ item, category: 'person' }]} selectedItemId={null} target="scene" showCamera={false} cameraKeyCount={0}
    onSelectTarget={vi.fn()} onSelectItem={select} onRename={vi.fn()} onToggleHidden={vi.fn()} onToggleLocked={unlock} />);
  fireEvent.click(screen.getByText('Locked actor')); expect(select).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'ui.stage.selection.show' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.selection.unlock' })); expect(unlock).toHaveBeenCalledWith(item);
});
