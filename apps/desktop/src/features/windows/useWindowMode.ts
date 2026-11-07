import { useCallback, useEffect, useState } from "react";
import { invoke, listen } from "../../platform/desktop";
import type { WindowMode } from "../../../shared/window-mode";

/** The host-owned window mode of this window; windows without modes stay "normal". */
export function useWindowMode() {
  const [state, setState] = useState<{ mode: WindowMode; desktopAvailable: boolean }>({
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
  return {
    mode: state.mode,
    /** Undefined when the window has no mode control to offer. */
    onModeChange: state.desktopAvailable || state.mode !== "normal" ? change : undefined,
  };
}
