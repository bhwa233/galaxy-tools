import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { invoke, listen } from "../../platform/desktop";
import type { CapsuleItem, CapsuleSnapshot } from "./types";
import "./capsules.css";
import { MarkdownPreviewLazy as MarkdownPreview } from "../markdown/MarkdownPreviewLazy";
function run(command: string, args?: unknown) {
  void invoke(command, args).catch(console.error);
}
/** Vector marks share a fixed box so glyph fallback cannot change their visual center. */
function CapsuleMark({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg
      className="capsule-mark"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="2.6" fill="currentColor" />
    </svg>
  ) : (
    <svg
      className="capsule-mark"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 13v-2.5L10.5 3 13 5.5 5.5 13H3z" />
      <path d="M9.3 4.2l2.5 2.5" />
    </svg>
  );
}
export function CapsuleHost() {
  const [state, setState] = useState<CapsuleSnapshot>();
  const gesture = useRef<{ pointerId: number; x: number; y: number; dragging: boolean } | null>(
    null,
  );
  const suppressClick = useRef(false);
  useEffect(() => {
    const off = listen<CapsuleSnapshot>("capsule-state", (e) => setState(e.payload));
    void invoke<CapsuleSnapshot>("capsule_state").then(setState).catch(console.error);
    return () => {
      void off.then((fn) => fn());
    };
  }, []);
  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>, item: CapsuleItem) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || current.dragging) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
    current.dragging = true;
    suppressClick.current = true;
    run("capsule_drag_start", { id: item.id });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || event.button !== 0) return;
    gesture.current = null;
    if (current.dragging) run("capsule_drag_end");
  };
  const cancel = (button: HTMLButtonElement) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    suppressClick.current = true;
    if (current.dragging) run("capsule_drag_end", { cancel: true });
    if (button.hasPointerCapture(current.pointerId))
      button.releasePointerCapture(current.pointerId);
  };
  if (!state) return null;
  if (state.kind === "preview" && state.note)
    return (
      <section className="capsule-preview" aria-label="便签预览">
        <header>
          <CapsuleMark expanded={false} />
          <strong>{state.note.title || "无标题便签"}</strong>
          <button type="button" onClick={() => run("capsule_open", { id: state.note!.id })}>
            展开 ↗
          </button>
        </header>
        <div className="capsule-preview-body" key={state.note.id}>
          {state.markdown ? (
            <MarkdownPreview
              content={state.note.content}
              imageBaseDir={state.imageBaseDir}
              imageDisplay={state.imageDisplay}
            />
          ) : (
            <pre>{state.note.content || "空白便签"}</pre>
          )}
        </div>
        <footer>悬停速览 · 点击展开后编辑</footer>
      </section>
    );
  return (
    <div
      className={`capsule-host capsule-${state.kind} capsule-${state.edge ?? "free"}`}
      onWheel={(e) =>
        run("capsule_scroll", {
          delta:
            state.edge === "top" && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY,
        })
      }
    >
      {state.items.map((item) => (
        <div
          key={item.id}
          className="capsule-item"
          style={{
            left: item.rect.x,
            top: item.rect.y,
            width: item.rect.width,
            height: item.rect.height,
            ...(item.clip
              ? {
                  clipPath: `inset(${item.clip.y}px ${item.rect.width - item.clip.x - item.clip.width}px ${item.rect.height - item.clip.y - item.clip.height}px ${item.clip.x}px)`,
                }
              : {}),
          }}
        >
          <button
            type="button"
            data-capsule-id={item.id}
            className={`capsule-pill ${item.master ? "capsule-master" : item.expanded ? "capsule-expanded" : ""}`}
            aria-label={
              item.master
                ? `花笺，${item.count} 张便签，${item.collapsed ? "展开" : "收起"}队列`
                : item.title
            }
            aria-expanded={item.master ? !item.collapsed : undefined}
            title={item.master ? "点击展开或收起队列，拖动调整位置" : item.title}
            onPointerDown={press}
            onPointerMove={(event) => move(event, item)}
            onPointerUp={finish}
            onPointerCancel={(event) => cancel(event.currentTarget)}
            onLostPointerCapture={(event) => cancel(event.currentTarget)}
            onPointerEnter={() => !item.master && run("capsule_hover", { id: item.id })}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel(e.currentTarget);
            }}
            onClick={(e) => {
              if (e.detail !== 0 && suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              run("capsule_activate", { id: item.id });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              cancel(e.currentTarget);
              run("capsule_menu", { id: item.id });
            }}
          >
            {item.master ? (
              <svg
                className="capsule-mark"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                {[0, 60, 120, 180, 240, 300].map((angle) => (
                  <ellipse
                    key={angle}
                    cx="8"
                    cy="4.5"
                    rx="1.8"
                    ry="3.3"
                    transform={`rotate(${angle} 8 8)`}
                  />
                ))}
                <circle cx="8" cy="8" r="1.5" fill="var(--color-bamboo)" />
              </svg>
            ) : (
              <CapsuleMark expanded={!!item.expanded} />
            )}
            <span className={item.master ? "capsule-count" : "capsule-label"}>
              {item.master ? item.count : item.title}
            </span>
            {item.master && (
              <svg
                className="capsule-chevron"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d={item.collapsed ? "m6 4 4 4-4 4" : "m10 4-4 4 4 4"} />
              </svg>
            )}
          </button>
          {!item.master && state.kind !== "drag" && (
            <button
              type="button"
              className="capsule-close"
              data-capsule-close={item.id}
              aria-label={`隐藏便签：${item.title}`}
              title="隐藏到托盘，保留内容"
              onClick={(e) => {
                e.stopPropagation();
                run("capsule_hide", { id: item.id });
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
