import { useCallback, useState } from "react";

interface SourceInspectorState {
  /** The inspected message; sources are looked up from it, never copied here. */
  messageKey: string | null;
  focusedN: number | null;
  flashToken: number;
}

/** State for the single Source Inspector a chat surface owns. */
export function useSourceInspector() {
  const [state, setState] = useState<SourceInspectorState>({ messageKey: null, focusedN: null, flashToken: 0 });

  /** The Sources button: opens this message's sources, or closes if it's already the one shown. */
  const toggle = useCallback((messageKey: string) => {
    setState((s) =>
      s.messageKey === messageKey
        ? { ...s, messageKey: null, focusedN: null }
        : { ...s, messageKey, focusedN: null },
    );
  }, []);

  /** A citation: always opens (or switches to) the message and focuses source n. */
  const openAt = useCallback((messageKey: string, n: number) => {
    setState((s) => ({ messageKey, focusedN: n, flashToken: s.flashToken + 1 }));
  }, []);

  const setFocused = useCallback((n: number | null) => {
    setState((s) => ({ ...s, focusedN: n }));
  }, []);

  const close = useCallback(() => {
    setState((s) => (s.messageKey === null ? s : { ...s, messageKey: null, focusedN: null }));
  }, []);

  return { ...state, toggle, openAt, setFocused, close };
}
