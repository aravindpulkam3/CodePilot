import { useEffect, useState } from "react";

/**
 * Live content width of an element, via a callback ref (the element may
 * mount after the component does, e.g. behind a loading state). The review
 * workspace lays itself out from its own width rather than the viewport's,
 * so collapsing the global sidebar immediately gives the code more room.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width };
}
