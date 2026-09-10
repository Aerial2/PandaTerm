import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** 可选副标题，例如协议说明 */
  description?: string;
};

type SelectDropdownProps<T extends string = string> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** 无匹配 value 时的占位文案 */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
};

/** 菜单在视口内的固定定位框 */
type MenuBox = {
  left: number;
  width: number;
  maxHeight: number;
  /** 向下展开：菜单顶边 */
  top?: number;
  /** 向上展开：相对视口底边的距离 */
  bottom?: number;
  placement: 'bottom' | 'top';
};

const MENU_GAP = 4;
const VIEWPORT_PAD = 8;
const MENU_PREFERRED_MAX = 220;

function measureMenuBox(trigger: HTMLElement): MenuBox {
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_PAD;
  const spaceAbove = rect.top - MENU_GAP - VIEWPORT_PAD;
  // 下方够放（或比上方更宽裕）则向下，否则向上
  const placeBottom = spaceBelow >= Math.min(MENU_PREFERRED_MAX, 120) || spaceBelow >= spaceAbove;
  const available = Math.max(80, placeBottom ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(MENU_PREFERRED_MAX, available);
  const left = Math.min(
    Math.max(VIEWPORT_PAD, rect.left),
    Math.max(VIEWPORT_PAD, window.innerWidth - rect.width - VIEWPORT_PAD),
  );

  if (placeBottom) {
    return {
      left,
      width: rect.width,
      maxHeight,
      top: rect.bottom + MENU_GAP,
      placement: 'bottom',
    };
  }
  return {
    left,
    width: rect.width,
    maxHeight,
    bottom: window.innerHeight - rect.top + MENU_GAP,
    placement: 'top',
  };
}

/**
 * 自定义下拉：替代原生 select/option（系统菜单样式不可控）。
 * - 菜单 portal + fixed，不撑开文档、不被 overflow 裁切
 * - 贴底时自动向上展开
 * - 点击 / Enter / Space 开合；↑↓ 高亮；Esc 关闭
 */
export function SelectDropdown<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: SelectDropdownProps<T>) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuBox, setMenuBox] = useState<MenuBox | null>(null);
  const [highlight, setHighlight] = useState(() =>
    Math.max(0, options.findIndex((item) => item.value === value)),
  );

  const selected = options.find((item) => item.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, options.findIndex((item) => item.value === value)));
  }, [open, options, value]);

  // 打开时测量 / 滚动与缩放时跟锚点
  useLayoutEffect(() => {
    if (!open) {
      setMenuBox(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;

    const update = () => {
      if (!triggerRef.current) return;
      setMenuBox(measureMenuBox(triggerRef.current));
    };
    update();

    window.addEventListener('resize', update);
    // capture：任意滚动容器内位移都能跟
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    // 仅在菜单内部滚动，避免带动页面
    item?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open, highlight]);

  function closeMenu() {
    setOpen(false);
    setMenuBox(null);
  }

  function openMenu() {
    if (triggerRef.current) {
      setMenuBox(measureMenuBox(triggerRef.current));
    }
    setOpen(true);
  }

  function pick(next: T) {
    onChange(next);
    closeMenu();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => {
        const len = options.length;
        if (len === 0) return 0;
        return (current + delta + len) % len;
      });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const option = options[highlight];
      if (option) pick(option.value);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu();
    }
  }

  const menuStyle: CSSProperties | undefined = menuBox
    ? {
        left: menuBox.left,
        width: menuBox.width,
        maxHeight: menuBox.maxHeight,
        top: menuBox.placement === 'bottom' ? menuBox.top : undefined,
        bottom: menuBox.placement === 'top' ? menuBox.bottom : undefined,
      }
    : undefined;

  const menu = open && menuBox
    ? createPortal(
        <ul
          ref={listRef}
          id={listId}
          className={`select-dropdown-menu is-portal is-${menuBox.placement}`}
          style={menuStyle}
          role="listbox"
          aria-activedescendant={`${listId}-opt-${highlight}`}
        >
          {options.map((option, index) => {
            const active = option.value === value;
            const focused = index === highlight;
            return (
              <li
                key={option.value}
                id={`${listId}-opt-${index}`}
                data-index={index}
                role="option"
                aria-selected={active}
                className={`select-dropdown-option${active ? ' is-selected' : ''}${focused ? ' is-highlight' : ''}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  // 避免 mousedown 先关菜单导致 click 丢失
                  event.preventDefault();
                  pick(option.value);
                }}
              >
                <span className="select-dropdown-option-label">{option.label}</span>
                {option.description ? (
                  <span className="select-dropdown-option-desc">{option.description}</span>
                ) : null}
              </li>
            );
          })}
        </ul>,
        document.body,
      )
    : null;

  return (
    <div
      ref={rootRef}
      className={`select-dropdown${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="select-dropdown-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => {
          if (disabled) return;
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`select-dropdown-value${selected ? '' : ' is-placeholder'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="select-dropdown-chevron" aria-hidden />
      </button>

      {menu}
    </div>
  );
}