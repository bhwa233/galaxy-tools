import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import * as Modal from "./ui/dialog";

// Reuse the existing Radix Dialog and form content. A page needs semantic
// headings instead of Radix portal/title context; no second modal is introduced.
const Embedded = createContext(false);
export function Dialog({
  embedded = false,
  children,
  ...props
}: ComponentProps<typeof Modal.Dialog> & { embedded?: boolean }) {
  return (
    <Embedded.Provider value={embedded}>
      {embedded ? props.open ? children : null : <Modal.Dialog {...props}>{children}</Modal.Dialog>}
    </Embedded.Provider>
  );
}
export function DialogContent({
  children,
  className,
  onDrop,
  onDragOver,
  ...props
}: ComponentProps<typeof Modal.DialogContent>) {
  return useContext(Embedded) ? (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-1"
      onDrop={onDrop}
      onDragOver={onDragOver}
      data-application-entry-drop={
        props["data-application-entry-drop" as keyof typeof props] ? "" : undefined
      }
    >
      {children}
    </section>
  ) : (
    <Modal.DialogContent className={className} onDrop={onDrop} onDragOver={onDragOver} {...props}>
      {children}
    </Modal.DialogContent>
  );
}
export function DialogHeader({ children, ...props }: ComponentProps<typeof Modal.DialogHeader>) {
  return <Modal.DialogHeader {...props}>{children}</Modal.DialogHeader>;
}
export function DialogFooter({ children, ...props }: ComponentProps<typeof Modal.DialogFooter>) {
  return <Modal.DialogFooter {...props}>{children}</Modal.DialogFooter>;
}
export function DialogTitle({ children }: { children?: ReactNode }) {
  return useContext(Embedded) ? (
    <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
  ) : (
    <Modal.DialogTitle>{children}</Modal.DialogTitle>
  );
}
export function DialogDescription({ children }: { children?: ReactNode }) {
  return useContext(Embedded) ? (
    <p className="text-sm text-muted-foreground">{children}</p>
  ) : (
    <Modal.DialogDescription>{children}</Modal.DialogDescription>
  );
}
