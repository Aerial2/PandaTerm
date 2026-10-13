import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { scrollHorizontallyOnWheel } from './wheelScroll';

export function AiSessionTabs({ children, label, activeId, tabList = false }: {
  children: ReactNode;
  label: string;
  activeId?: string | null;
  tabList?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; scrollLeft: number; scale: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scroll, setScroll] = useState({ left: 0, width: 0, total: 0 });

  function measure() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = { left: viewport.scrollLeft, width: viewport.clientWidth, total: viewport.scrollWidth };
    setScroll((current) => current.left === next.left && current.width === next.width && current.total === next.total
      ? current : next);
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    for (const child of viewport.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [children]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => scrollHorizontallyOnWheel({
      currentTarget: viewport,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      preventDefault: () => event.preventDefault(),
    });
    // React 的 wheel 监听是 passive，原生监听才能阻止外层同时滚动。
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const active = viewport?.querySelector<HTMLElement>('.ai-session-tab.active');
    if (!viewport || !active) return;
    const bounds = viewport.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < bounds.left) viewport.scrollLeft += tab.left - bounds.left;
    else if (tab.right > bounds.right) viewport.scrollLeft += tab.right - bounds.right;
    measure();
  }, [activeId]);

  const overflowing = scroll.total > scroll.width;
  const thumbWidth = overflowing ? Math.min(100, Math.max(8, scroll.width / scroll.total * 100)) : 100;
  const thumbLeft = overflowing ? scroll.left / (scroll.total - scroll.width) * (100 - thumbWidth) : 0;

  return (
    <div className={`ai-session-tabs-shell${dragging ? ' dragging' : ''}`}>
      <div ref={viewportRef} className="ai-session-tabs" role={tabList ? 'tablist' : undefined}
        aria-label={label} onScroll={measure}>
        {children}
      </div>
      {overflowing && (
        <div ref={trackRef} className="ai-session-scrollbar" aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const viewport = viewportRef.current;
            const track = trackRef.current;
            if (!viewport || !track) return;
            event.preventDefault();
            const bounds = track.getBoundingClientRect();
            const travel = bounds.width * (1 - thumbWidth / 100);
            if (travel <= 0) return;
            const scale = (viewport.scrollWidth - viewport.clientWidth) / travel;
            if (event.target === track) {
              viewport.scrollLeft = (event.clientX - bounds.left - bounds.width * thumbWidth / 200) * scale;
            }
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, scrollLeft: viewport.scrollLeft, scale };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            measure();
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId || !viewportRef.current) return;
            viewportRef.current.scrollLeft = drag.scrollLeft + (event.clientX - drag.x) * drag.scale;
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            dragRef.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            dragRef.current = null;
            setDragging(false);
          }}>
          <div className="ai-session-scrollbar-thumb" style={{ width: `${thumbWidth}%`, left: `${thumbLeft}%` }} />
        </div>
      )}
    </div>
  );
}
