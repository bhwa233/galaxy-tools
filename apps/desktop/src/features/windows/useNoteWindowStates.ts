import { useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../platform/desktop";
import {
  NOTE_WINDOW_STATES_CHANGED,
  type NoteWindowSnapshot,
  type NoteWindowState,
} from "./noteWindowState";
/** Both the list and paper consume one main-process snapshot; late initial reads cannot undo events. */
export function useNoteWindowStates() {
  const [states, setStates] = useState<Record<string, NoteWindowState>>({});
  const version = useRef(-1);
  useEffect(() => {
    let disposed = false;
    const apply = (snapshot: NoteWindowSnapshot) => {
      if (disposed || snapshot.version < version.current) return;
      version.current = snapshot.version;
      setStates(Object.fromEntries(snapshot.notes.map((state) => [state.noteId, state])));
    };
    const off = listen<NoteWindowSnapshot>(NOTE_WINDOW_STATES_CHANGED, (event) =>
      apply(event.payload),
    );
    void invoke<NoteWindowSnapshot>("note_window_states").then(apply).catch(console.error);
    return () => {
      disposed = true;
      void off.then((fn) => fn());
    };
  }, []);
  return states;
}
