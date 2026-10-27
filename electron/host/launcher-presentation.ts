interface LauncherFocusState {
  label: string;
  visible: boolean;
  focused: boolean;
  ownedDialog: boolean;
  composingUntil: number;
  devToolsFocused: boolean;
}
/** The shared host role also includes settings and workspaces. Only the named
 * search panel follows transient launcher focus behavior. */
export function shouldHideLauncher(state: LauncherFocusState, now = Date.now()): boolean {
  return (
    state.label === "launcher" &&
    state.visible &&
    !state.focused &&
    !state.ownedDialog &&
    state.composingUntil < now &&
    !state.devToolsFocused
  );
}
