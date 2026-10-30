import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { OcrSession, OcrDocument } from "../../../shared/ocr-sessions";

export function selectionUnits(result: OcrSession, document: OcrDocument) {
  return result.lines.flatMap((line, index) => {
    const range = document.ranges[index];
    if (!range) return [];
    // TinyOCR supplies actual character boxes. Edited rows and older results
    // retain line selection; never invent character positions from line width.
    if (!line.characters?.length || document.text.slice(range.start, range.end) !== line.text)
      return [{ ...range, text: document.text.slice(range.start, range.end), box: line.box }];
    let cursor = range.start;
    return line.characters.flatMap((character) => {
      const start = document.text.indexOf(character.text, cursor);
      if (start < cursor || start + character.text.length > range.end) return [];
      cursor = start + character.text.length;
      return [{ start, end: cursor, text: character.text, box: character.box }];
    });
  });
}

export function OcrImage({
  result,
  document,
  selection,
  onSelect,
}: {
  result: OcrSession;
  document: OcrDocument;
  selection: { start: number; end: number };
  onSelect: (start: number, end: number) => void;
}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(1);
  const units = selectionUnits(result, document);
  const anchor = useRef<number | undefined>(undefined);
  const dragging = useRef(false);
  const space = useRef(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const viewport = useRef<HTMLDivElement>(null);
  const choose = (index: number, extend: boolean) => {
    if (!extend || anchor.current === undefined) anchor.current = index;
    const first = units[anchor.current] ?? units[index],
      last = units[index];
    onSelect(Math.min(first.start, last.start), Math.max(first.end, last.end));
  };
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}
        >
          {t("ocr.zoomOut")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={zoom >= 8}
          onClick={() => setZoom((value) => Math.min(8, value * 1.25))}
        >
          {t("ocr.zoomIn")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setZoom(1);
            viewport.current?.scrollTo(0, 0);
          }}
        >
          {t("ocr.fit")}
        </Button>
        <span className="text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
      </div>
      <p className="text-xs text-muted-foreground">{t("ocr.selectionHelp")}</p>
      <div ref={viewport} className="min-h-48 flex-1 overflow-auto rounded-md border">
        <svg
          className="block touch-none select-none"
          style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
          viewBox={`0 0 ${result.width} ${result.height}`}
          tabIndex={0}
          role="group"
          aria-label={t("ocr.selection")}
          onBlur={() => {
            space.current = false;
          }}
          onKeyDown={(event) => {
            if (event.code === "Space") {
              space.current = true;
              event.preventDefault();
            }
            if (event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onSelect(0, document.text.length);
            }
          }}
          onKeyUp={(event) => {
            if (event.code === "Space") space.current = false;
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 1) return;
            if (space.current || event.button === 1) {
              const node = viewport.current!;
              pan.current = {
                x: event.clientX,
                y: event.clientY,
                left: node.scrollLeft,
                top: node.scrollTop,
              };
            } else {
              const index = Number(
                (event.target as Element).closest("[data-unit]")?.getAttribute("data-unit") ?? -1,
              );
              if (index < 0) return;
              choose(index, event.shiftKey);
              dragging.current = true;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (pan.current && viewport.current) {
              viewport.current.scrollLeft = pan.current.left + pan.current.x - event.clientX;
              viewport.current.scrollTop = pan.current.top + pan.current.y - event.clientY;
              return;
            }
            if (!dragging.current || !units.length) return;
            const matrix = event.currentTarget.getScreenCTM();
            if (!matrix) return;
            const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
              matrix.inverse(),
            );
            let nearest = 0,
              distance = Infinity;
            units.forEach((unit, index) => {
              const center = unit.box.reduce(
                (sum, pair) => ({ x: sum.x + pair[0] / 4, y: sum.y + pair[1] / 4 }),
                { x: 0, y: 0 },
              );
              const next = (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
              if (next < distance) {
                nearest = index;
                distance = next;
              }
            });
            choose(nearest, true);
          }}
          onLostPointerCapture={() => {
            dragging.current = false;
            pan.current = undefined;
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            pan.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          <image
            href={`spark233://resource/${encodeURIComponent(result.source.id)}`}
            width={result.width}
            height={result.height}
          />
          {units.map((unit, index) => (
            <polygon
              key={index}
              data-unit={index}
              points={unit.box.map((point) => point.join(",")).join(" ")}
              fill="currentColor"
              fillOpacity={selection.start < unit.end && selection.end > unit.start ? 0.25 : 0.04}
              stroke="currentColor"
              strokeWidth={1}
              role="button"
              tabIndex={0}
              aria-label={unit.text}
              aria-pressed={selection.start < unit.end && selection.end > unit.start}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(index, event.shiftKey);
                }
              }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
