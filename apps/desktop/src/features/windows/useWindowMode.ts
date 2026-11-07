import { useCallback, useEffect, useState } from "react";
import { invoke, listen } from "../../platform/desktop";
import type { WindowMode, WindowModeState } from "../../../shared/window-mode";

/** The host-owned window mode of this window; windows without modes stay "normal". */
export function useWindowMode() {
  const [state, setState] = useState<WindowModeState>({
    mode: "normal",
    desktopAvailable: false,
  });
  useEffect(() => {
    let disposed = false;
    void invoke("window_control", { action: "modeState" })
      .then((value) => {
        if (!disposed && value) setState(value);
      })
      .catch(() => {});
    const stop = listen("window-mode-changed", ({ payload }) => {
      if (!disposed) setState(payload);
    });
    return () => {
      disposed = true;
      void stop.then((off) => off()).catch(() => {});
    };
  }, []);
  const change = useCallback(
    (next: WindowMode) => invoke("window_control", { action: "mode", value: next }),
    [],
  );
  const lock = useCallback(
    (locked: boolean) => invoke("window_control", { action: "lock", value: locked }),
    [],
  );
  return {
    mode: state.mode,
    locked: !!state.locked,
    hint: state.hint,
    highlighted: !!state.highlighted,
    /** Undefined when the window has no mode control to offer. */
    onModeChange: state.desktopAvailable || state.mode !== "normal" ? change : undefined,
    onLockChange: state.mode === "desktop" ? lock : undefined,
  };
}
