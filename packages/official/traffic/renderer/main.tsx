import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Pause, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, Badge, Button } from "@spark233/ui/components";
import type { JsonValue } from "../../../sdk/src/index.js";
import type {
  TrafficProcessAction,
  TrafficProcessActionResult,
  TrafficScope,
  TrafficState,
} from "../traffic-contract";
import { ConnectionsDialog } from "./connections";
import { HistoryView } from "./history";
import { RealtimeView } from "./realtime";
import { TerminateDialog, type ProcessSelection } from "./process-actions";
import { client, coverageLabels, errorMessage, request } from "./traffic-ui";
import "../../../../apps/desktop/src/App.css";
import "./traffic.css";

export function TrafficPage() {
  const [tab, setTab] = useState<"realtime" | "history">("realtime");
  const [state, setState] = useState<TrafficState>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ProcessSelection>();
  const selectedIds = useMemo(() => selected?.instances.map((instance) => instance.id), [selected]);
  const [termination, setTermination] = useState<ProcessSelection>();
  const [notice, setNotice] = useState<string>();
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
  const runProcessAction = async (selection: ProcessSelection, action: TrafficProcessAction) => {
    if (mutation.current) return;
    mutation.current = true;
    ++generation.current;
    setBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const ids = selection.instances.map((instance) => instance.id);
      const value = await request<TrafficProcessActionResult>("process.action", {
        scope: selection.scope,
        appId: selection.row.appId,
        action,
        processInstanceIds: action === "terminate" ? ids : ids.slice(0, 1),
        ...(action === "terminate" ? { confirmed: true } : {}),
      });
      if (!mounted.current) return;
      const failed = value.results.filter((result) => result.status === "failed");
      if (failed.length)
        setActionError(
          failed
            .map(
              (result) =>
                `PID ${selection.instances.find((instance) => instance.id === result.instanceId)?.pid ?? "—"}：${result.message}`,
            )
            .join("；"),
        );
      if (action === "terminate") {
        const ended = value.results.filter((result) => result.status === "terminated").length;
        const exited = value.results.filter((result) => result.status === "exited").length;
        setNotice(
          `已结束 ${ended} 个进程${exited ? `，${exited} 个进程已退出` : ""}${failed.length ? `，${failed.length} 个操作失败` : ""}。`,
        );
        setTermination(undefined);
      } else if (!failed.length)
        setNotice(action === "reveal" ? "已在资源管理器中定位程序文件。" : "已打开文件属性窗口。");
    } catch (value) {
      if (mounted.current) setActionError(errorMessage(value));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const processAction = (selection: ProcessSelection, action: TrafficProcessAction) => {
    if (busy) return;
    if (action === "terminate") setTermination(selection);
    else void runProcessAction(selection, action);
  };
  const needsEnable = Boolean(
    state?.process.canEnable &&
    ["not-installed", "unavailable", "error"].includes(state.process.status),
  );
  const processNotice =
    state && state.process.status !== "collecting" && state.process.status !== "paused";
  return (
    <main className="traffic-page">
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
      {notice && (
        <div className="traffic-notice" role="status">
          {notice}
        </div>
      )}
      <RealtimeView
        active={tab === "realtime"}
        state={state}
        onConnections={setSelected}
        onAction={processAction}
      />
      <HistoryView active={tab === "history"} scope={scope} icons={state?.icons ?? {}} />
      {selected && (
        <ConnectionsDialog
          key={`${selected.scope}:${selected.row.appId}:${selected.instances.map((instance) => instance.id).join(",")}`}
          row={selected.row}
          scope={selected.scope}
          instanceIds={selectedIds}
          onClose={() => setSelected(undefined)}
        />
      )}
      {termination && (
        <TerminateDialog
          selection={termination}
          busy={busy}
          onCancel={() => setTermination(undefined)}
          onConfirm={() => void runProcessAction(termination, "terminate")}
        />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<TrafficPage />);
