import type { WheelEvent } from 'react';

// 让横向排布的 tab / chip 条支持鼠标滚轮横滑：
// 纵向或横向滚轮 delta 统一转成 scrollLeft。未溢出或已到边界时不拦截，把事件交还外层。
export function scrollHorizontallyOnWheel(event: WheelEvent<HTMLElement>) {
  const el = event.currentTarget;
  if (el.scrollWidth <= el.clientWidth) return;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (delta === 0) return;
  const max = el.scrollWidth - el.clientWidth;
  const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
  if (next === el.scrollLeft) return;
  event.preventDefault();
  el.scrollLeft = next;
}