import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, Badge, Button, WindowTitleBar } from "@spark233/ui/components";
import type { JsonValue } from "../../../sdk/src/index.js";
import type { TrafficProcessRow, TrafficScope, TrafficState } from "../traffic-contract";
import { ConnectionsDialog } from "./connections";
import { HistoryView } from "./history";
import { RealtimeView } from "./realtime";
import { client, coverageLabels, errorMessage, request } from "./traffic-ui";
import "../../../../apps/desktop/src/App.css";
import "./traffic.css";

function TrafficPage() {
  const [tab, setTab] = useState<"realtime" | "history">("realtime");
  const [state, setState] = useState<TrafficState>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<TrafficProcessRow>();
  const [maximized, setMaximized] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const theme = client.onTheme((value) => {
      document.documentElement.dataset.theme = value.effective;
    });
    let windowRevision = 0;
    const refreshWindow = () => {
      const revision = ++windowRevision;
      void client.window
        .isMaximized()
        .then((value) => {
          if (active && revision === windowRevision) setMaximized(value);
        })
        .catch((value) => {
          if (active && revision === windowRevision) setActionError(errorMessage(value));
        });
    };
    window.addEventListener("resize", refreshWindow);
    refreshWindow();
    const stop = client.onPrepareStop(() => {
      active = false;
      mounted.current = false;
      generation.current += 1;
      clearTimeout(timer);
      return { ok: true };
    });
    const refresh = async () => {
      const version = generation.current;
      try {
        if (mutation.current) return;
        const value = await request<TrafficState>("snapshot");
        if (active && version === generation.current) {
          setState(value);
          setError(undefined);
        }
      } catch (value) {
        if (active && version === generation.current) setError(errorMessage(value));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void client
      .context()
      .then((context) => {
        if (active) document.documentElement.dataset.theme = context.theme.effective;
      })
      .catch((value) => {
        if (active) setError(errorMessage(value));
      });
    void refresh();
    return () => {
      active = false;
      mounted.current = false;
      generation.current += 1;
      clearTimeout(timer);
      theme();
      stop();
      window.removeEventListener("resize", refreshWindow);
    };
  }, []);
  const act = async (commandId: string, parameters?: JsonValue) => {
    if (mutation.current) return;
    mutation.current = true;
    const version = ++generation.current;
    setBusy(true);
    setActionError(undefined);
    try {
      const value = await request<TrafficState>(commandId, parameters);
      if (mounted.current && version === generation.current) {
        setState(value);
        setError(undefined);
      }
    } catch (value) {
      if (mounted.current && version === generation.current) setActionError(errorMessage(value));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const scope = state?.process.scope ?? "own";
  const needsEnable = Boolean(
    state?.process.canEnable &&
    ["not-installed", "unavailable", "error"].includes(state.process.status),
  );
  const processNotice =
    state && state.process.status !== "collecting" && state.process.status !== "paused";
  const windowAction = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (value) {
      if (mounted.current) setActionError(errorMessage(value));
    }
  };
  return (
    <main className="traffic-page">
      <WindowTitleBar
        title="流量监控"
        isMaximized={maximized}
        labels={{ minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" }}
        onMinimize={() => void windowAction(client.window.minimize)}
        onToggleMaximize={() => void windowAction(client.window.toggleMaximize)}
        onClose={() => void windowAction(client.close)}
      />
      <header className="traffic-topbar">
        <nav className="traffic-tabs" aria-label="流量视图">
          <Button
            className="traffic-tab"
            variant="ghost"
            aria-pressed={tab === "realtime"}
            onClick={() => setTab("realtime")}
          >
            实时流量
          </Button>
          <Button
            className="traffic-tab"
            variant="ghost"
            aria-pressed={tab === "history"}
            onClick={() => setTab("history")}
          >
            历史流量
          </Button>
        </nav>
        <div className="traffic-top-actions">
          <select
            className="traffic-select"
            aria-label="进程统计范围"
            value={scope}
            disabled={busy || !state}
            onChange={(event) =>
              void act("process.scope", { scope: event.target.value as TrafficScope })
            }
          >
            <option value="own">当前账户</option>
            <option value="machine" disabled={!state?.process.canMachine}>
              整机（需授权）
            </option>
          </select>
          <Badge
            variant="secondary"
            title={
              state?.process.message ||
              (state?.process.coverage === "gap"
                ? "缺失数值显示为 —，历史仅累计已采集的流量。"
                : "进程采样状态")
            }
          >
            {state ? coverageLabels[state.process.coverage] : "连接中"}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={state?.paused ? "继续采集" : "暂停采集"}
            title={state?.paused ? "继续采集" : "暂停采集"}
            disabled={busy || !state}
            onClick={() => void act("pause", { paused: !state?.paused })}
          >
            {state?.paused ? <Play size={14} /> : <Pause size={14} />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重新连接采集器"
            title="重新连接采集器"
            disabled={busy}
            onClick={() => void act("retry")}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </header>
      {(actionError || error) && (
        <div className="traffic-notice pt-3">
          <Alert variant="destructive">
            <AlertDescription>{actionError || error}</AlertDescription>
          </Alert>
        </div>
      )}
      {processNotice && (
        <div className="traffic-notice pt-3">
          <Alert>
            <AlertDescription>
              <div className="traffic-notice-line">
                <span className="traffic-notice-text">
                  <strong>
                    {state.process.status === "not-installed"
                      ? "启用按程序流量统计"
                      : state.process.status === "starting"
                        ? "正在连接进程采集服务"
                        : "进程采集暂不可用"}
                  </strong>
                  {(state.process.status === "error" || state.process.status === "unavailable") &&
                    state.process.message && <span>{state.process.message}</span>}
                </span>
                {needsEnable && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void act("process.enable", { scope })}
                  >
                    <ShieldCheck size={14} />
                    {busy ? "正在启用…" : scope === "machine" ? "授权整机采集" : "启用进程采集"}
                  </Button>
                )}
              </div>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <RealtimeView active={tab === "realtime"} state={state} onConnections={setSelected} />
      <HistoryView active={tab === "history"} scope={scope} icons={state?.icons ?? {}} />
      {selected && (
        <ConnectionsDialog
          key={`${scope}:${selected.appId}`}
          row={selected}
          scope={scope}
          onClose={() => setSelected(undefined)}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<TrafficPage />);
