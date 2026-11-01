import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Clock, Network, TriangleAlert } from "lucide-react";
import {
  isWidgetRankRows,
  type DeclarativeNode,
  type DeclarativeTemplate,
  type WidgetDataFrame,
  type WidgetTone,
} from "@spark233/sdk";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { getErrorMessage } from "../notes/api";

const toneClass: Record<WidgetTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  accent: "text-primary",
  warning: "text-muted-foreground",
  danger: "text-destructive",
  upload: "text-orange-500",
  download: "text-emerald-500",
};
const iconComponents = {
  clock: Clock,
  network: Network,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  warning: TriangleAlert,
};

export interface DeclarativeCardProps {
  template: DeclarativeTemplate;
  data?: WidgetDataFrame;
  disabled: boolean;
  locale?: string;
  images?: Readonly<Record<string, string>>;
  onAction: (actionId: string) => Promise<void>;
  onContentHeight?: (height: number) => void;
}

/** Only the SDK's bounded template vocabulary reaches this trusted component.
 * Reuses Button and native progress; a fixed SVG path covers the bounded series
 * without adding a chart runtime or evaluating plugin markup, CSS or expressions.
 */
export const DeclarativeCard = memo(function DeclarativeCard({
  template,
  data,
  disabled,
  locale = "zh-CN",
  images,
  onAction,
  onContentHeight,
}: DeclarativeCardProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  // Reuse the popup positioning observer pattern; measure this card's natural
  // content rather than its host section, whose height changes after reporting.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!onContentHeight || !content) return;
    let frame: number | undefined;
    let lastHeight: number | undefined;
    const measure = () => {
      frame = undefined;
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (!Number.isFinite(height) || height <= 0 || height === lastHeight) return;
      lastHeight = height;
      onContentHeight(height);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(content);
    schedule();
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [onContentHeight]);
  const values = data?.values ?? {};
  const draw = (node: DeclarativeNode, key: string): React.ReactNode => {
    if (node.type === "stack")
      return (
        <div
          key={key}
          className="layer-stack"
          style={{
            flexDirection: node.direction,
            gap: node.gap,
            alignItems: { start: "flex-start", center: "center", end: "flex-end" }[node.align],
          }}
        >
          {node.children.map((child, index) => draw(child, `${key}.${index}`))}
        </div>
      );
    const color = toneClass[node.tone];
    switch (node.type) {
      case "text": {
        const value = "text" in node.value ? node.value.text : values[node.value.dataKey];
        if (value === "") return null;
        return (
          <span
            key={key}
            className={cn("layer-text", color)}
            style={{
              fontSize: { caption: 12, body: 14, title: 18 }[node.size],
              WebkitLineClamp: node.maxLines,
            }}
          >
            {typeof value === "string" || typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : "—"}
          </span>
        );
      }
      case "number": {
        const value = values[node.dataKey];
        return (
          <span key={key} className={cn("layer-number", color)}>
            {typeof value === "number" && Number.isFinite(value)
              ? new Intl.NumberFormat(locale, {
                  minimumFractionDigits: node.decimals,
                  maximumFractionDigits: node.decimals,
                }).format(value)
              : "—"}
            {node.unit && <small>{node.unit}</small>}
          </span>
        );
      }
      case "progress": {
        const value = values[node.dataKey];
        return typeof value === "number" && Number.isFinite(value) ? (
          <progress
            key={key}
            className={cn("layer-progress", color)}
            max={1}
            value={Math.max(0, Math.min(1, value))}
            aria-label={node.dataKey}
          />
        ) : (
          <span key={key} className={color}>
            —
          </span>
        );
      }
      case "icon": {
        const selected = node.dataKey ? values[node.dataKey] : (node.name ?? node.resourceId);
        const Icon =
          typeof selected === "string" && Object.hasOwn(iconComponents, selected)
            ? iconComponents[selected as keyof typeof iconComponents]
            : undefined;
        if (Icon)
          return (
            <Icon key={key} width={node.size} height={node.size} className={color} aria-hidden />
          );
        const source = typeof selected === "string" ? images?.[selected] : undefined;
        // Main process only publishes validated PNG data URLs for logical handles.
        return source?.startsWith("data:image/png;base64,") ? (
          <img
            key={key}
            src={source}
            width={node.size}
            height={node.size}
            alt=""
            draggable={false}
          />
        ) : (
          <span key={key} className={color} aria-hidden>
            —
          </span>
        );
      }
      case "sparkline": {
        const value = values[node.dataKey];
        if (
          !Array.isArray(value) ||
          value.length < 2 ||
          !value.every((item) => typeof item === "number" && Number.isFinite(item))
        )
          return (
            <span key={key} className={color}>
              —
            </span>
          );
        const series = value.slice(-120);
        const minimum = node.min ?? Math.min(...series);
        const maximum = node.max ?? Math.max(...series);
        const range = maximum - minimum;
        const path = series
          .map((point, index) => {
            const x = (index / (series.length - 1)) * 100;
            const y = range > 0 ? 30 - ((point - minimum) / range) * 28 : 16;
            return `${index ? "L" : "M"}${x.toFixed(2)},${Math.max(2, Math.min(30, y)).toFixed(2)}`;
          })
          .join(" ");
        return (
          <svg
            key={key}
            viewBox="0 0 100 32"
            className={cn("layer-sparkline", color)}
            role="img"
            aria-label={node.dataKey}
          >
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        );
      }
      case "rank-list": {
        const rows = values[node.dataKey];
        return (
          <div key={key} className="layer-rank-list">
            {isWidgetRankRows(rows) && rows.length ? (
              rows.map((row) => {
                const source = row.iconId ? images?.[row.iconId] : undefined;
                return (
                  <div key={row.id} className="layer-rank-row">
                    {source?.startsWith("data:image/png;base64,") ? (
                      <img src={source} width={18} height={18} alt="" draggable={false} />
                    ) : (
                      <Network
                        width={18}
                        height={18}
                        className="text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="layer-rank-label" title={row.label}>
                      {row.label}
                    </span>
                    <span className={cn("layer-rank-value", color)}>{row.valueText}</span>
                  </div>
                );
              })
            ) : (
              <span className="layer-text text-muted-foreground">
                {locale.startsWith("zh") ? "暂无流量" : "No traffic"}
              </span>
            )}
          </div>
        );
      }
      case "button":
        return (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={node.tone === "danger" ? "destructive" : "outline"}
            disabled={disabled || !!pendingAction}
            onClick={(event) => {
              event.stopPropagation();
              setPendingAction(node.actionId);
              setActionError(undefined);
              void onAction(node.actionId)
                .catch((error) => {
                  setActionError(getErrorMessage(error).slice(0, 180));
                })
                .finally(() => setPendingAction(undefined));
            }}
          >
            {node.label}
          </Button>
        );
    }
  };
  const style: CSSProperties = { padding: template.padding };
  return (
    <div
      ref={contentRef}
      className={cn(
        "declarative-card",
        onContentHeight && "declarative-card-intrinsic",
        template.background === "card" && "declarative-card-background",
      )}
      style={style}
    >
      {draw(template.root, "root")}
      {actionError && (
        <span className="layer-action-error" role="alert">
          {actionError}
        </span>
      )}
    </div>
  );
});
