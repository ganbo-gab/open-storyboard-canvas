import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Follow streaming output only while the reader stays near the latest message. */
export function useConversationScroll(sessionId: string | null | undefined, contentVersion: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [browsingHistory, setBrowsingHistory] = useState(false);
  const [showNewItems, setShowNewItems] = useState(false);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setBrowsingHistory((browsing) => distance < 48 ? false : distance > 240 ? true : browsing);
    if (following.current) setShowNewItems(false);
  }, []);
  const jumpToLatest = useCallback(() => {
    following.current = true;
    setBrowsingHistory(false);
    setShowNewItems(false);
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, []);
  useLayoutEffect(() => { following.current = true; setBrowsingHistory(false); setShowNewItems(false); }, [sessionId]);
  useLayoutEffect(() => {
    if (!following.current) { setShowNewItems(true); return; }
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element && following.current) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionId, contentVersion]);
  // Images and expanded tool steps can change height after the message render.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    });
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [sessionId, contentVersion]);
  return { scrollRef, onScroll, browsingHistory, showNewItems, jumpToLatest };
}
