import { lazy, Suspense, useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { invoke, listen } from "../../platform/desktop";
import type { CapsuleItem, CapsuleSnapshot } from "./types";
import "./capsules.css";
const MarkdownPreview = lazy(() =>
  import("../markdown/MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })),
);
function run(command: string, args?: unknown) {
  void invoke(command, args).catch(console.error);
}
export function CapsuleHost() {
  const [state, setState] = useState<CapsuleSnapshot>();
  useEffect(() => {
    const off = listen<CapsuleSnapshot>("capsule-state", (e) => setState(e.payload));
    void invoke<CapsuleSnapshot>("capsule_state").then(setState).catch(console.error);
    return () => {
      void off.then((fn) => fn());
    };
  }, []);
  const drag = (event: PointerEvent<HTMLButtonElement>, item: CapsuleItem) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    run("capsule_drag_start", { id: item.id });
  };
  if (!state) return null;
  if (state.kind === "preview" && state.note)
    return (
      <section className="capsule-preview" aria-label="便签预览">
        <header>
          <span className="capsule-mark">✎</span>
          <strong>{state.note.title || "无标题便签"}</strong>
          <button type="button" onClick={() => run("capsule_open", { id: state.note!.id })}>
            展开 ↗
          </button>
        </header>
        <div className="capsule-preview-body" key={state.note.id}>
          {state.markdown ? (
            <Suspense fallback={<pre>{state.note.content}</pre>}>
              <MarkdownPreview content={state.note.content} imageBaseDir={state.imageBaseDir} />
            </Suspense>
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
      onWheel={(e) => run("capsule_scroll", { delta: e.deltaY })}
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
            title={item.master ? "点击展开或收起队列，拖动调整位置" : item.title}
            onPointerDown={(e) => drag(e, item)}
            onPointerUp={(e) => {
              if (e.button === 0) run("capsule_drag_end");
            }}
            onPointerCancel={() => run("capsule_drag_end", { cancel: true })}
            onLostPointerCapture={() => run("capsule_drag_end", { cancel: true })}
            onPointerEnter={() => !item.master && run("capsule_hover", { id: item.id })}
            onKeyDown={(e) => {
              if (e.key === "Escape") run("capsule_drag_end", { cancel: true });
            }}
            onClick={(e) => {
              if (e.detail === 0) {
                if (item.master) {
                  run("capsule_drag_start", { id: item.id });
                  run("capsule_drag_end");
                } else run("capsule_open", { id: item.id });
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              run("capsule_menu", { id: item.id });
            }}
          >
            <span className="capsule-mark" aria-hidden="true">
              {item.master ? "✿" : item.expanded ? "◦" : "✎"}
            </span>
            <span className="capsule-label">{item.master ? item.count : item.title}</span>
            {item.master && <span className="capsule-chevron">{item.collapsed ? "›" : "‹"}</span>}
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
