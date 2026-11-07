// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StageCapturePanel } from './StageCapturePanel';
import { stageCommands } from '../application/stageCommands';
import { openMediaViewer } from '@/features/viewer/viewerStore';
import { publishStageCaptures } from '../application/publishStageCaptures';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../application/stageCommands', () => ({ stageCommands: { capture: vi.fn(), captureFourViews: vi.fn(async () => ({ images: ['front', 'right', 'back', 'left'].map((view) => ({ view, assetId: view })) })) } }));
vi.mock('../application/publishStageCaptures', () => ({ publishStageCaptures: vi.fn(async () => ['node1', 'node2', 'node3', 'node4']) }));
vi.mock('@/features/assets/application/assetCatalog', () => ({ resolveAsset: vi.fn(async (id: string) => ({ id, kind: 'image', source: `https://fixture.invalid/${id}.png`, name: id })) }));
vi.mock('@/features/viewer/viewerStore', () => ({ openMediaViewer: vi.fn() }));
vi.mock('@/features/assets/ui/AssetMedia', () => ({ AssetMedia: ({ alt }: { alt: string }) => <span>{alt}</span> }));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('captures four views at the exact requested time and publishes their original asset IDs together', async () => {
  render(<StageCapturePanel nodeId="stage" duration={12} currentTime={() => 3.5} />);
  fireEvent.click(screen.getByRole('radio', { name: 'ui.stage.capture.exact' }));
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4.25' } });
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.capture.four' }));
  await waitFor(() => expect(stageCommands.captureFourViews).toHaveBeenCalledWith('stage', 4.25, expect.any(AbortSignal)));
  await screen.findByRole('button', { name: 'ui.stage.capture.front · ui.stage.capture.open' });
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.capture.send' }));
  await waitFor(() => expect(publishStageCaptures).toHaveBeenCalledWith('stage', ['front', 'right', 'back', 'left']));
  expect(stageCommands.capture).not.toHaveBeenCalled();
});

it('keeps captured views while hidden and blocks repeated viewer sends in the same tick', async () => {
  const gate = Promise.withResolvers<string[]>();
  vi.mocked(publishStageCaptures).mockReturnValueOnce(gate.promise);
  const view = render(<div hidden={false}><StageCapturePanel nodeId="stage" duration={12} currentTime={() => 0} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.capture.four' }));
  await screen.findByRole('button', { name: 'ui.stage.capture.front · ui.stage.capture.open' });
  view.rerender(<div hidden><StageCapturePanel nodeId="stage" duration={12} currentTime={() => 0} /></div>);
  view.rerender(<div hidden={false}><StageCapturePanel nodeId="stage" duration={12} currentTime={() => 0} /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'ui.stage.capture.front · ui.stage.capture.open' }));
  const action = vi.mocked(openMediaViewer).mock.calls[0]?.[0][0].primaryActions?.[0].run;
  if (!action) throw new Error('Expected a send action in the viewer');
  act(() => { void action(); void action(); });
  expect(publishStageCaptures).toHaveBeenCalledTimes(1);
  await act(async () => { gate.resolve(['node']); await gate.promise; });
});
