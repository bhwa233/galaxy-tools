import { useEffect, useState } from "react";
import { ClipboardWorkspace, type ClipboardWorkspaceProps } from "../clipboard/ClipboardWorkspace";
import type { ClipboardRequest } from "../clipboard/types";
import { invoke, listen } from "../../platform/desktop";
import { registerHostPreparation } from "../windows/hostPreparation";

export function ClipboardPanel({
  onClose,
  onResult,
  compact = false,
  availableTextTargets,
  imageOcrAvailable,
  unavailableTargetReason,
}: {
  onClose: () => void;
  onResult: (result: unknown) => void;
  compact?: boolean;
  availableTextTargets: ClipboardWorkspaceProps["availableTextTargets"];
  imageOcrAvailable: boolean;
  unavailableTargetReason: string;
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
      availableTextTargets={availableTextTargets}
      imageOcrAvailable={imageOcrAvailable}
      unavailableTargetReason={unavailableTargetReason}
      registerPrepare={registerHostPreparation}
      onSendText={async (target, text) => {
        if (!availableTextTargets[target]) throw new Error(unavailableTargetReason);
        onResult(
          await invoke("text_action", { target: target === "ai" ? "translate" : target, text }),
        );
      }}
      onSendImage={async (id) => {
        if (!imageOcrAvailable) throw new Error(unavailableTargetReason);
        onResult(await invoke("clipboard_image_ocr", { id }));
      }}
    />
  );
}
