import { useEffect, useState } from "react";
import { ClipboardWorkspace } from "../clipboard/ClipboardWorkspace";
import type { ClipboardRequest } from "../clipboard/types";
import { invoke, listen } from "../../platform/desktop";

export function ClipboardPanel({
  onClose,
  compact = false,
}: {
  onClose: () => void;
  compact?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const subscription = listen("clipboard-changed", () => setRevision((value) => value + 1));
    return () => {
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, []);
  return (
    <ClipboardWorkspace
      request={(request: ClipboardRequest) => invoke("clipboard_action", request)}
      onClose={onClose}
      revision={revision}
      compact={compact}
    />
  );
}
