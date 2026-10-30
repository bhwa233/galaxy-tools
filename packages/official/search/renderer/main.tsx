import { mountDesktopApp } from "../../../../apps/desktop/src/platform/mount";
import { PluginWindow } from "../../../../apps/desktop/src/features/windows/PluginWindow";
import { SearchWorkspace } from "../../../../apps/desktop/src/features/search/SearchWorkspace";
import {
  SearchPreviewDialog,
  type SearchPreview,
} from "../../../../apps/desktop/src/features/search/SearchPreviewDialog";
import { useEffect, useState } from "react";
function SearchPage({
  payload,
  activationRevision,
  onClose,
}: {
  payload: unknown;
  activationRevision: number;
  onClose: () => Promise<void>;
}) {
  const [input, setInput] = useState<{
    query?: string;
    mode?: "files" | "content";
    revision: number;
  }>({ revision: 0 });
  const [preview, setPreview] = useState<SearchPreview>();
  useEffect(() => {
    const value = payload as
      | {
          query?: string;
          preview?: SearchPreview;
          activation?: { commandId?: string; context?: { kind: string; text?: string } };
        }
      | undefined;
    if (!value) return;
    if (value.preview) {
      setPreview(value.preview);
      return;
    }
    if (value.activation || Object.hasOwn(value, "query")) {
      const command = value.activation?.commandId;
      const query =
        value.query ??
        (value.activation?.context?.kind === "text" ? value.activation.context.text : undefined);
      setInput({
        query,
        revision: activationRevision,
        mode:
          command === "content"
            ? "content"
            : command && command !== "workspace"
              ? "files"
              : undefined,
      });
      setPreview(undefined);
    }
  }, [payload, activationRevision]);
  return (
    <>
      <SearchWorkspace
        key={input.revision}
        initialQuery={input.query}
        initialMode={input.mode}
        onClose={onClose}
      />
      <SearchPreviewDialog
        value={preview}
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      />
    </>
  );
}
const Page = () => (
  <PluginWindow>
    {(content) => (
      <SearchPage
        payload={content.payload}
        activationRevision={content.activationRevision}
        onClose={content.onClose}
      />
    )}
  </PluginWindow>
);
void mountDesktopApp(Page);
