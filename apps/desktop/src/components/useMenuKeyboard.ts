import { useEffect, useEffectEvent } from "react";

const ITEMS = 'button:not([disabled]), [role="menuitem"]:not([aria-disabled="true"])';

/**
 * Keyboard behaviour for the hand-built popup menus: focus moves into the menu
 * when it opens, Arrow/Home/End rove between items, Esc closes it, and focus
 * returns to where it was. Runs in the capture phase so Esc closes only the
 * menu, not the window behind it.
 */
export function useMenuKeyboard(
  ref: { readonly current: HTMLElement | null },
  open: boolean,
  close: () => void,
): void {
  const onClose = useEffectEvent(close);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const frame = requestAnimationFrame(() => items()[0]?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      const list = items();
      if (!list.length || event.isComposing) return;
      const index = list.indexOf(document.activeElement as HTMLElement);
      const move = (next: number) => {
        event.preventDefault();
        event.stopPropagation();
        list[(next + list.length) % list.length]?.focus({ preventScroll: true });
      };
      if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index < 0 ? list.length - 1 : index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(list.length - 1);
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected && ref.current?.contains(document.activeElement))
        previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
