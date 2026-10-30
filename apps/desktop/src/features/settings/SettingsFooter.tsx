import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FooterTarget = createContext<HTMLDivElement | null | undefined>(undefined);

// Move each editor's existing save controls into the settings shell without
// transferring ownership of drafts, save guards or pending operations.
export function SettingsFooterHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <FooterTarget.Provider value={target}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
        <div ref={setTarget} className="shrink-0 empty:hidden" />
      </div>
    </FooterTarget.Provider>
  );
}

export function SettingsFooter({
  status,
  statusTestId,
  children,
}: {
  status: ReactNode;
  statusTestId?: string;
  children?: ReactNode;
}) {
  const target = useContext(FooterTarget);
  const footer = (
    <footer className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-t bg-background px-6 py-2">
      <span
        role="status"
        data-testid={statusTestId}
        className="mr-auto min-w-0 break-words text-xs text-muted-foreground"
      >
        {status}
      </span>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </footer>
  );
  if (target === undefined) return footer;
  return target ? createPortal(footer, target) : null;
}
