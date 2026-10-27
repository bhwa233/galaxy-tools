import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SearchPreview {
  path: string;
  line: number;
  snippet: string;
  text: string;
  firstLine: number;
}
export function SearchPreviewDialog({
  value,
  open,
  onOpenChange,
}: {
  value: SearchPreview | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("search");
  const hit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) hit.current?.scrollIntoView({ block: "center" });
  }, [open, value]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("previewTitle")}</DialogTitle>
          <DialogDescription className="break-all">
            {value?.path}
            {value?.line ? `:${value.line}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div
          className="overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
          tabIndex={0}
        >
          {value?.text.split(/\r?\n/).map((text, index) => {
            const line = value.firstLine + index,
              selected = line === value.line;
            return (
              <div
                key={line}
                ref={selected ? hit : undefined}
                className={`flex gap-3 whitespace-pre ${selected ? "bg-accent text-accent-foreground" : ""}`}
              >
                <span aria-hidden className="min-w-10 select-none text-right text-muted-foreground">
                  {line}
                </span>
                <span>{text || " "}</span>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("previewHelp")}</p>
      </DialogContent>
    </Dialog>
  );
}
