// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationScroll } from './useConversationScroll';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('tracks browsing before new output and does not pull the reader down during updates', () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let current: ReturnType<typeof useConversationScroll>;
  function Feed({ version }: { version: number }) {
    current = useConversationScroll('one', version);
    return <div ref={current.scrollRef} onScroll={current.onScroll} data-testid="feed" />;
  }
  const view = render(<Feed version={1} />);
  const feed = view.getByTestId('feed');
  Object.defineProperties(feed, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  feed.scrollTop = 400;
  fireEvent.scroll(feed);
  expect(current!.browsingHistory).toBe(true);
  expect(current!.showNewItems).toBe(false);
  view.rerender(<Feed version={2} />);
  expect(feed.scrollTop).toBe(400);
  expect(current!.showNewItems).toBe(true);
  act(() => { feed.scrollTop = 1500; fireEvent.scroll(feed); });
  expect(current!.browsingHistory).toBe(false);
  expect(current!.showNewItems).toBe(false);
});
