import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { ClipboardWorkspace } from "../../../../apps/desktop/src/features/clipboard/ClipboardWorkspace";
import { invoke, listen } from "../../../../apps/desktop/src/platform/desktop";
import { useEffect, useState } from "react";
import type { ClipboardRequest } from "../../../../apps/desktop/src/features/clipboard/types";
function Content({ compact, onClose }: { compact: boolean; onClose: () => Promise<void> }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const off = listen("clipboard-changed", () => setRevision((value) => value + 1));
    return () => {
      void off.then((stop) => stop());
    };
  }, []);
  return (
    <ClipboardWorkspace
      compact={compact}
      revision={revision}
      onClose={onClose}
      request={(request: ClipboardRequest) => invoke("clipboard_action", request)}
    />
  );
}
const Page = () => (
  <PluginWindow>
    {({ onClose, info }) => <Content compact={info.presentation === "compact"} onClose={onClose} />}
  </PluginWindow>
);
void mountDesktopApp(Page);
