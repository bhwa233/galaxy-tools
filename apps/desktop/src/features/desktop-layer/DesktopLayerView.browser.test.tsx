import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type {
  LayerClient,
  LayerClientRequest,
  LayerEvent,
  LayerSnapshot,
} from "../../../shared/layer-contract";
import { DesktopLayerView } from "./DesktopLayerView";
import { DeclarativeCard } from "./DeclarativeCard";
import { parseDeclarativeTemplate } from "@spark233/sdk";
import hud from "../../../../../packages/official/traffic/widgets/hud.json";
import trafficPackage from "../../../../../packages/official/traffic/package.json";

it("coalesces slow pointer replies, retires queued moves at gesture boundaries and fences geometry generations", async () => {
  // A slow host previously accumulated one IPC per animation frame. Releasing
  // capture could also deliver cancel before up, losing the final drag commit.
  const snapshot: LayerSnapshot = {
    protocol: 1,
    surfaceId: "fixture",
    surfaceGeneration: 1,
    revision: 1,
    theme: "light",
    locale: "zh-CN",
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1100, height: 850 },
    editing: false,
    cards: [
      {
        id: "hud",
        consumerId: "widgets",
        renderKind: "declarative",
        renderRef: "hud",
        title: "Fixture traffic HUD",
        displayId: "primary",
        group: "top",
        inputMode: "interactive",
        bounds: { x: 20, y: 20, width: 140, height: 52 },
        order: 1,
        visible: true,
        desktopInteractive: true,
        template: {
          version: 1,
          padding: 4,
          background: "card",
          root: {
            type: "text",
            value: { text: "Traffic" },
            size: "body",
            tone: "default",
            maxLines: 1,
          },
        },
      },
    ],
  };
  let listener!: (event: LayerEvent) => void;
  const requests: LayerClientRequest[] = [];
  const held: (() => void)[] = [];
  const client: LayerClient = {
    request: (request) => {
      requests.push(request);
      if (request.type === "ready") return Promise.resolve(snapshot);
      if (request.type === "pointer" && request.event.type === "move")
        return new Promise<void>((resolve) => held.push(resolve));
      return Promise.resolve(undefined);
    },
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
  };
  const moves = () =>
    requests.filter((request) => request.type === "pointer" && request.event.type === "move");
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const view = await render(<DesktopLayerView client={client} />);
  let mounted = true;
  try {
    await expect
      .poll(() => document.querySelector('section[aria-label="Fixture traffic HUD"]'))
      .toBeTruthy();
    const card = document.querySelector<HTMLElement>('section[aria-label="Fixture traffic HUD"]')!;
    const pointer = (type: string, x: number) =>
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: 30,
        }),
      );
    pointer("pointermove", 30);
    await expect.poll(() => moves().length).toBe(1);
    for (const x of [40, 60, 100]) {
      pointer("pointermove", x);
      await frame();
    }
    expect(moves()).toHaveLength(1);
    held.shift()!();
    await expect.poll(() => moves().length).toBe(2);
    const latest = moves()[1]!;
    expect(latest.type === "pointer" && latest.event.x).toBe(80);

    pointer("pointermove", 120);
    // Use the DOM capture contract without requiring a physical desktop pointer.
    let captured = true;
    card.hasPointerCapture = () => captured;
    card.releasePointerCapture = () => {
      captured = false;
      pointer("lostpointercapture", 130);
    };
    pointer("pointerup", 130);
    const boundaries = requests.filter((request) => request.type === "pointer").slice(-2);
    expect(boundaries.map((request) => request.type === "pointer" && request.event.type)).toEqual([
      "up",
      "cancel",
    ]);
    held.shift()!();
    await frame();
    await frame();
    expect(moves()).toHaveLength(2);

    listener({
      type: "geometry",
      surfaceGeneration: 1,
      revision: 1,
      cards: [{ cardId: "hud", bounds: { x: 80, y: 90, width: 140, height: 52 } }],
    });
    await expect.poll(() => card.style.left).toBe("80px");
    listener({
      type: "geometry",
      surfaceGeneration: 0,
      revision: 1,
      cards: [{ cardId: "hud", bounds: { x: 999, y: 90, width: 140, height: 52 } }],
    });
    await frame();
    expect(card.style.left).toBe("80px");

    pointer("pointermove", 100);
    await expect.poll(() => moves().length).toBe(3);
    pointer("pointermove", 110);
    listener({ type: "snapshot", snapshot: { ...snapshot, surfaceGeneration: 2 } });
    held.shift()!();
    await frame();
    await frame();
    expect(moves()).toHaveLength(3);

    pointer("pointermove", 100);
    await expect.poll(() => moves().length).toBe(4);
    pointer("pointermove", 110);
    await view.unmount();
    mounted = false;
    held.shift()!();
    await frame();
    await frame();
    expect(moves()).toHaveLength(4);
  } finally {
    for (const complete of held) complete();
    if (mounted) await view.unmount();
  }
});

it("keeps the traffic HUD width stable and its natural height balanced without clipping long rates", async () => {
  // A fixed outer height left extra empty space below the two rate rows.
  const template = parseDeclarativeTemplate(hud);
  const { width } = trafficPackage.spark233.ui.widgets.hud.size;
  const onContentHeight = () => {};
  const content = (tx: string, rx: string) => (
    <div style={{ width }}>
      <DeclarativeCard
        template={template}
        disabled={false}
        onAction={async () => {}}
        onContentHeight={onContentHeight}
        data={{ revision: 1, at: 1, values: { "tx-text": tx, "rx-text": rx } }}
      />
    </div>
  );
  const view = await render(content("1.9 MB/s", "18.7 KB/s"));
  try {
    const card = view.container.querySelector<HTMLElement>(".declarative-card")!;
    await document.fonts.ready;
    const initial = card.getBoundingClientRect();
    for (const [tx, rx] of [
      ["0 B/s", "1.0 KB/s"],
      ["111.11 KB/s", "1023.99 MB/s"],
      ["999.99 GB/s", "1023.99 GB/s"],
    ]) {
      await view.rerender(content(tx, rx));
      expect(card.getBoundingClientRect().width).toBe(initial.width);
      expect(card.getBoundingClientRect().height).toBe(initial.height);
      const rows = card.querySelector<HTMLElement>(".layer-stack")!.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      expect(Math.abs(rows.top - bounds.top - (bounds.bottom - rows.bottom))).toBeLessThan(1);
      for (const text of card.querySelectorAll<HTMLElement>(".layer-text")) {
        expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
        expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight);
        expect(text.getBoundingClientRect().right).toBeLessThan(
          card.getBoundingClientRect().right - 2,
        );
      }
    }
  } finally {
    await view.unmount();
  }
});
