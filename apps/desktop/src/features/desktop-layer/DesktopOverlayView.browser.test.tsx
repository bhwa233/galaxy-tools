import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { JsonValue } from "@spark233/sdk";
import { parseDeclarativeTemplate } from "@spark233/sdk";
import type {
  LayerClient,
  LayerClientRequest,
  LayerEvent,
  LayerRenderCard,
  LayerSnapshot,
} from "../../../shared/layer-contract";
import { DesktopLayerView } from "./DesktopLayerView";
import hud from "../../../../../packages/official/traffic/widgets/hud.json";
import hover from "../../../../../packages/official/traffic/widgets/traffic-hover.json";

it("preserves desktop content in both themes while bar controls move and hide only bar panels", async () => {
  // The bar formerly enlarged traffic text/gaps and replaced note capsules with
  // a separate summary. Compare actual composed views so CSS overrides fail.
  const common = {
    consumerId: "fixture",
    displayId: "primary",
    group: "top" as const,
    inputMode: "interactive" as const,
    order: 1,
    visible: true,
  };
  const cards: LayerRenderCard[] = [
    {
      ...common,
      id: "traffic",
      renderKind: "declarative",
      renderRef: "hud",
      title: "Fixture traffic",
      bounds: { x: 150, y: 170, width: 110, height: 46 },
      intrinsicHeight: true,
      template: parseDeclarativeTemplate(hud),
      hover: { template: parseDeclarativeTemplate(hover), size: { width: 260, height: 300 } },
      data: {
        revision: 1,
        at: 1,
        values: {
          "tx-text": "111.11 KB/s",
          "rx-text": "1023.99 GB/s",
          "upload-top": [],
          "download-top": [],
          "process-status": "fixture collection status",
        },
      },
    },
    {
      ...common,
      id: "note",
      renderKind: "notes",
      renderRef: "note-1",
      title: "Fixture note",
      bounds: { x: 360, y: 220, width: 170, height: 32 },
      payload: {
        kind: "floating",
        items: [
          { id: "note-1", title: "Fixture note", rect: { x: 0, y: 0, width: 170, height: 32 } },
        ],
      } as JsonValue,
    },
    {
      ...common,
      id: "image",
      renderKind: "screenshot",
      renderRef: "image-1",
      title: "Fixture image",
      bounds: { x: 640, y: 270, width: 240, height: 160 },
      screenshot: {
        imageUrl: "spark233://app/__screenshot-image/11111111-1111-4111-8111-111111111111",
        pixelWidth: 240,
        pixelHeight: 160,
        editable: true,
      },
    },
  ];
  const base: LayerSnapshot = {
    protocol: 1,
    surfaceId: "fixture",
    surfaceGeneration: 1,
    revision: 1,
    theme: "light",
    locale: "zh-CN",
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1100, height: 850 },
    editing: false,
    cards,
  };
  const requests: LayerClientRequest[] = [];
  let listener!: (event: LayerEvent) => void;
  const client: LayerClient = {
    request: async (request) => {
      requests.push(request);
      return request.type === "ready" ? base : undefined;
    },
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
  };
  const view = await render(<DesktopLayerView client={client} />);
  const styles = (selector: string) => {
    const element = view.container.querySelector<HTMLElement>(selector)!;
    const style = getComputedStyle(element);
    return {
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      font: style.fontSize,
      lineHeight: style.lineHeight,
      color: style.color,
      background: style.backgroundColor,
      border: style.border,
      radius: style.borderRadius,
      padding: style.padding,
      gap: style.gap,
    };
  };
  const appearance = () =>
    [".declarative-card", ".layer-text", ".layer-stack", ".capsule-pill", ".layer-screenshot"].map(
      styles,
    );
  try {
    await expect.poll(() => view.container.querySelector(".capsule-pill")).toBeTruthy();
    await document.fonts.ready;
    const nodes = [".declarative-card", ".capsule-pill", ".layer-screenshot-image"].map(
      (selector) => view.container.querySelector(selector),
    );
    const assertSameNodes = () => {
      [".declarative-card", ".capsule-pill", ".layer-screenshot-image"].forEach((selector, i) =>
        expect(view.container.querySelector(selector)).toBe(nodes[i]),
      );
    };
    for (const theme of ["light", "dark"] as const) {
      listener({ type: "snapshot", snapshot: { ...base, theme } });
      await expect
        .poll(() => document.documentElement.classList.contains("dark"))
        .toBe(theme === "dark");
      await expect.poll(() => view.container.querySelector(".desktop-layer-root")).toBeTruthy();
      assertSameNodes();
      const ordinary = appearance();
      listener({
        type: "snapshot",
        snapshot: {
          ...base,
          theme,
          overlay: {
            displayId: "primary",
            panels: cards.map((card) => ({
              cardId: card.id,
              title: card.title!,
              kind: card.id === "traffic" ? "traffic" : card.id === "note" ? "notes" : "screenshot",
              selected: true,
              pinned: true,
              inputMode: "interactive",
            })),
          },
        },
      });
      await expect.poll(() => view.container.querySelector(".desktop-overlay")).toBeTruthy();
      expect(appearance()).toEqual(ordinary);
      assertSameNodes();
      const panel = view.container.querySelector<HTMLElement>('[data-overlay-panel="traffic"]')!;
      expect(panel.getBoundingClientRect().width).toBe(cards[0]!.bounds.width);
      expect(panel.getBoundingClientRect().height).toBe(cards[0]!.bounds.height);
      const handle = panel.querySelector<HTMLElement>(".desktop-overlay-panel-title")!;
      handle.focus();
      const header = panel.querySelector<HTMLElement>("header")!;
      expect(getComputedStyle(header).opacity).toBe("1");
      expect(header.getBoundingClientRect().bottom).toBeLessThan(panel.getBoundingClientRect().top);
    }
    await userEvent.hover(page.getByText("111.11 KB/s", { exact: true }));
    await expect
      .poll(() => view.container.querySelector(".desktop-overlay-preview .layer-rank-list"))
      .toBeTruthy();
    expect(view.container.querySelector(".desktop-overlay-preview")!.textContent).toContain(
      "fixture collection status",
    );
    // At the bottom edge the upward preview previously covered the external
    // management controls, making pin/move/hide inaccessible under the list.
    const lowerCards = cards.map((card) =>
      card.id === "traffic" ? { ...card, bounds: { ...card.bounds, y: 780 } } : card,
    );
    listener({
      type: "snapshot",
      snapshot: {
        ...base,
        theme: "dark",
        cards: lowerCards,
        overlay: {
          displayId: "primary",
          panels: cards.map((card) => ({
            cardId: card.id,
            title: card.title!,
            kind: card.id === "traffic" ? "traffic" : card.id === "note" ? "notes" : "screenshot",
            selected: true,
            pinned: true,
            inputMode: "interactive",
          })),
        },
      },
    });
    await expect
      .poll(
        () =>
          view.container
            .querySelector<HTMLElement>('[data-overlay-panel="traffic"]')!
            .getBoundingClientRect().top,
      )
      .toBe(780);
    await userEvent.hover(page.getByText("111.11 KB/s", { exact: true }));
    await expect
      .poll(() => view.container.querySelector(".desktop-overlay-preview-above"))
      .toBeTruthy();
    const preview = view.container
      .querySelector<HTMLElement>(".desktop-overlay-preview")!
      .getBoundingClientRect();
    const controls = view.container
      .querySelector<HTMLElement>('[data-overlay-panel="traffic"] header')!
      .getBoundingClientRect();
    expect(preview.bottom).toBeLessThanOrEqual(controls.top);
    const note = view.container.querySelector<HTMLElement>('[data-overlay-panel="note"]')!;
    const handle = note.querySelector<HTMLElement>(".desktop-overlay-panel-title")!;
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(requests).toContainEqual({
      type: "overlay-layout",
      cardId: "note",
      bounds: { ...cards[1]!.bounds, x: cards[1]!.bounds.x + 10 },
    });
    note.querySelector<HTMLButtonElement>(".capsule-close")!.click();
    expect(requests).toContainEqual({ type: "overlay-panel", cardId: "note", action: "hide" });
    note.querySelector<HTMLButtonElement>(".capsule-pill")!.click();
    expect(requests).toContainEqual({ type: "overlay-panel", cardId: "note", action: "open" });
    expect(
      requests.some(
        (request) =>
          request.type === "notes-invoke" &&
          ["capsule_drag_start", "capsule_scroll", "capsule_hide"].includes(request.command),
      ),
    ).toBe(false);
    const panels = cards.map((card) => ({
      cardId: card.id,
      title: card.title!,
      selected: false,
      pinned: true,
      inputMode: "interactive" as const,
      kind: (card.id === "traffic" ? "traffic" : card.id === "note" ? "notes" : "screenshot") as
        | "traffic"
        | "notes"
        | "screenshot",
    }));
    listener({
      type: "snapshot",
      snapshot: {
        ...base,
        cards: cards.map((card) => ({
          ...card,
          visible: false,
        })),
        presentationRevision: 5,
        overlay: { displayId: "primary", epoch: 7, host: false, panels },
      },
    });
    await expect
      .poll(
        () =>
          getComputedStyle(view.container.querySelector('[data-overlay-panel="traffic"]')!).display,
      )
      .toBe("none");
    assertSameNodes();
    await expect
      .poll(() => requests.some((r) => r.type === "presentation-committed" && r.revision === 5))
      .toBe(true);
    listener({ type: "snapshot", snapshot: { ...base, presentationRevision: 6 } });
    await expect.poll(() => view.container.querySelector("[data-overlay-panel]")).toBeNull();
    assertSameNodes();
    expect(cards[1]!.bounds).toEqual({ x: 360, y: 220, width: 170, height: 32 });
  } finally {
    await view.unmount();
  }
});
