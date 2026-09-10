/**
 * 浮层菜单锚点（viewport 坐标，用于 portal 定位）
 */

export type FloatingMenuAnchor = {
  left: number;
  top: number;
  bottom: number;
  width: number;
};

export function measureFloatingMenuAnchor(element: HTMLElement): FloatingMenuAnchor {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
  };
}

export function clampFloatingMenuLeft(left: number, minWidth: number) {
  const maxLeft = Math.max(8, window.innerWidth - minWidth - 8);
  return Math.min(Math.max(8, left), maxLeft);
}