import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { WidgetBinding, WidgetConnectMessage } from "@spark233/sdk";
import type { LayerClient, LayerEvent } from "../../../shared/layer-contract";
import { Button } from "../../components/ui/button";

export interface WidgetFrameProps {
  binding: WidgetBinding;
  url: string;
  nonce: string;
  initialWire: string;
  client: LayerClient;
  blocked: boolean;
}

/** The trusted shell owns the port; the child gets no Electron preload. */
export function WidgetFrame({
  binding,
  url,
  nonce,
  initialWire,
  client,
  blocked,
}: WidgetFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | undefined>(undefined);
  const connected = useRef<string | undefined>(undefined);
  const pending = useRef<string[]>([]);
  const current = useRef({ binding, nonce });
  const [openMain, setOpenMain] = useState<Extract<LayerEvent, { type: "widget-open-main" }>>();
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string>();
  useLayoutEffect(() => {
    current.current = { binding, nonce };
  }, [binding, nonce]);
  useLayoutEffect(() => {
    if (!openMain) return;
    const timer = window.setTimeout(
      () => setOpenMain(undefined),
      Math.max(0, openMain.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [openMain]);
  const connect = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target || connected.current === nonce) return;
    port.current?.close();
    const channel = new MessageChannel();
    let invalidMessages = 0;
    port.current = channel.port1;
    connected.current = nonce;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (current.current.nonce !== nonce) return;
      if (
        typeof event.data !== "string" ||
        event.data.length > 20 * 1024 ||
        new TextEncoder().encode(event.data).byteLength > 20 * 1024
      ) {
        if (++invalidMessages !== 3) return;
        channel.port1.close();
        port.current = undefined;
        pending.current = [];
        void client
          .request({
            type: "fault",
            code: "widget-protocol-error",
            message: "Widget bridge repeatedly sent invalid or oversized messages",
          })
          .catch(() => {});
        return;
      }
      void client
        .request({ type: "widget-relay", binding: current.current.binding, wire: event.data })
        .catch(() => {});
    };
    channel.port1.start();
    const message: WidgetConnectMessage = {
      type: "spark233-widget-connect",
      protocol: 1,
      nonce,
      ...binding,
    };
    target.postMessage(message, "*", [channel.port2]);
    channel.port1.postMessage(initialWire);
    for (const wire of pending.current) channel.port1.postMessage(wire);
    pending.current = [];
  }, [binding, client, initialWire, nonce]);
  useLayoutEffect(() => {
    const boot = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      const value = event.data as { type?: unknown; protocol?: unknown };
      if (value.type === "spark233-widget-boot" && value.protocol === 1) connect();
    };
    const off = client.subscribe((event) => {
      if (event.type === "widget-open-main") {
        const active = current.current.binding;
        if (
          event.widgetInstanceId === active.widgetInstanceId &&
          event.loadGeneration === active.loadGeneration &&
          event.expiresAt > Date.now()
        ) {
          setOpenMain(event);
          setConfirming(false);
          setConfirmationError(undefined);
        }
        return;
      }
      if (event.type === "widget-open-main-cleared") {
        setOpenMain((value) => (value?.candidateId === event.candidateId ? undefined : value));
        setConfirming(false);
        return;
      }
      if (event.type !== "widget-wire") return;
      if (port.current) port.current.postMessage(event.wire);
      else if (pending.current.length < 8) pending.current.push(event.wire);
    });
    window.addEventListener("message", boot);
    return () => {
      off();
      window.removeEventListener("message", boot);
      if (port.current) {
        port.current.onmessage = null;
        port.current.close();
        port.current = undefined;
      }
      connected.current = undefined;
      pending.current = [];
    };
  }, [client, connect]);
  return (
    <>
      <iframe
        ref={frame}
        src={url}
        title={binding.widgetDefinitionId}
        className="layer-widget-frame"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        tabIndex={-1}
        onLoad={connect}
      />
      {blocked && <div className="layer-web-blocked" aria-hidden />}
      {openMain && !blocked && (
        <div
          className="layer-open-main-confirmation"
          role="group"
          aria-label={openMain.title}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            size="sm"
            disabled={confirming}
            title={openMain.title}
            onClick={(event) => {
              if (!event.isTrusted) return;
              event.stopPropagation();
              setConfirming(true);
              setConfirmationError(undefined);
              void client
                .request({
                  type: "widget-confirm-open",
                  cardId: openMain.cardId,
                  candidateId: openMain.candidateId,
                  allow: true,
                })
                .catch((error) => {
                  setConfirming(false);
                  setConfirmationError(String(error).slice(0, 160));
                });
            }}
          >
            {openMain.label}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={confirming}
            onClick={(event) => {
              if (!event.isTrusted) return;
              event.stopPropagation();
              setConfirming(true);
              void client
                .request({
                  type: "widget-confirm-open",
                  cardId: openMain.cardId,
                  candidateId: openMain.candidateId,
                  allow: false,
                })
                .catch((error) => {
                  setConfirming(false);
                  setConfirmationError(String(error).slice(0, 160));
                });
            }}
          >
            {openMain.dismissLabel}
          </Button>
          {confirmationError && <span role="status">{confirmationError}</span>}
        </div>
      )}
    </>
  );
}
