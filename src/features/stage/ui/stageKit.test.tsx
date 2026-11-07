// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrubNumber } from './stageKit';
afterEach(cleanup);
it('commits a typed duration once on Enter, and Escape restores without committing on blur', () => {
  const commit = vi.fn();
  render(<ScrubNumber label="Duration" value={4} onCommit={commit} />);
  const field = screen.getByRole('textbox', { name: 'Duration' });
  field.focus(); fireEvent.change(field, { target: { value: '6' } }); fireEvent.keyDown(field, { key: 'Enter' });
  expect(commit).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledWith(6);
  field.focus(); fireEvent.change(field, { target: { value: '8' } }); fireEvent.keyDown(field, { key: 'Escape' });
  expect(commit).toHaveBeenCalledTimes(1);
});
