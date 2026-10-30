import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, listen, getCurrentWindow } from "../../platform/desktop";
import type { PluginWindowActivation, PluginWindowInfo } from "../../../shared/plugin-windows";
import { PluginWindowContext } from "./PluginWindowContext";
import { prepareHostWindow } from "./hostPreparation";
import { DesktopWindow } from "./DesktopWindow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export interface PluginWindowContent {
  info: PluginWindowInfo;
  payload: unknown;
  activationRevision: number;
  onClose: () => Promise<void>;
}

/** A plugin entry owns its page imports. This shell only handles the existing
 * desktop lifecycle and the owner-bound activation channel, never launcher queries. */
export function PluginWindow({
  children,
  documentWindow = false,
}: {
  children: (content: PluginWindowContent) => ReactNode;
  documentWindow?: boolean;
}) {
  const [info, setInfo] = useState<PluginWindowInfo>();
  const [activation, setActivation] = useState<PluginWindowActivation>();
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    let infoRevision = 0;
    const refresh = async () => {
      const request = ++infoRevision;
      try {
        const next = await invoke("plugin_window_info");
        if (active && request === infoRevision) {
          setInfo(next);
          setError(undefined);
        }
      } catch (value) {
        if (active && request === infoRevision)
          setError(
            value && typeof value === "object" && "message" in value
              ? String(value.message)
              : String(value),
          );
      }
    };
    const accept = (next?: PluginWindowActivation) => {
      if (!active || !next || next.revision <= revision.current) return;
      revision.current = next.revision;
      setActivation(next);
    };
    const subscription = listen("plugin-window-activation", ({ payload }) => accept(payload));
    const changed = [
      listen("plugins-changed", () => void refresh()),
      listen("config-changed", () => void refresh()),
    ];
    void refresh();
    void subscription
      .then(() => (active ? invoke("plugin_window_take_activation") : undefined))
      .then(accept)
      .catch((value) => {
        if (active)
          setError(
            value && typeof value === "object" && "message" in value
              ? String(value.message)
              : String(value),
          );
      });
    return () => {
      active = false;
      for (const stop of [subscription, ...changed]) void stop.then((off) => off()).catch(() => {});
    };
  }, [retry]);
  const onClose = async () => {
    try {
      await prepareHostWindow();
      await getCurrentWindow().close();
    } catch (value) {
      setError(
        value && typeof value === "object" && "message" in value
          ? String(value.message)
          : String(value),
      );
    }
  };
  if (!info && error)
    return (
      <DesktopWindow>
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
          <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
            {t("common.retry")}
          </Button>
          <Button variant="ghost" onClick={() => void onClose()}>
            {t("main.window.close")}
          </Button>
        </Alert>
      </DesktopWindow>
    );
  if (!info)
    return (
      <main className="flex h-screen items-center justify-center bg-background p-4 text-foreground">
        <Spinner />
      </main>
    );
  return (
    <PluginWindowContext value={info}>
      <DesktopWindow prepareClose={!documentWindow} transparent={documentWindow}>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {children({
          info,
          payload: activation?.payload,
          activationRevision: activation?.revision ?? 0,
          onClose,
        })}
      </DesktopWindow>
    </PluginWindowContext>
  );
}
