import { useState } from "react";

interface ResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Never wider than this fraction of the viewport. */
  maxViewportFraction?: number;
}

/**
 * Width state for a right-hand panel resized from its left edge, persisted to
 * localStorage. Same behaviour as ReviewAIPanel's resize handle (drag left to
 * grow, arrow keys in 24px steps), which still has its own copy — migrating
 * it here is deferred with the rest of the review work.
 */
export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  maxViewportFraction = 0.5,
}: ResizableWidthOptions) {
  const clamp = (w: number) => {
    const max = Math.min(maxWidth, typeof window !== "undefined" ? window.innerWidth * maxViewportFraction : maxWidth);
    return Math.min(max, Math.max(minWidth, w));
  };

  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isNaN(parsed)) return clamp(parsed);
    } catch {
      // ignore (private browsing, etc.)
    }
    return defaultWidth;
  });

  const persist = (w: number) => {
    setWidth(w);
    try {
      localStorage.setItem(storageKey, String(w));
    } catch {
      // ignore
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      persist(clamp(startWidth + (startX - moveEvent.clientX)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") persist(clamp(width + 24));
    else if (e.key === "ArrowRight") persist(clamp(width - 24));
  };

  return { width, handleProps: { onPointerDown, onKeyDown } };
}
