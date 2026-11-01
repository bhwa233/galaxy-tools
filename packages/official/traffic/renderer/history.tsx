import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Alert, AlertDescription } from "@spark233/ui/components";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../apps/desktop/src/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../../apps/desktop/src/components/ui/alert-dialog";
import {
  formatTrafficBytes,
  type TrafficCategory,
  type TrafficHistoryResult,
  type TrafficHistoryRow,
  type TrafficScope,
} from "../traffic-contract";
import { Input } from "@spark233/ui/components";
import {
  CategoryFilter,
  ProgramName,
  SortLabel,
  TrafficEmpty,
  TrafficSearch,
  categoryLabels,
  coverageLabels,
  client,
  errorMessage,
  request,
} from "./traffic-ui";

type Period = "today" | "yesterday" | "week" | "month" | "custom";
type Sort = "name" | "category" | "rx" | "tx" | "total";
const periods: Array<[Period, string]> = [
  ["today", "今天"],
  ["yesterday", "昨天"],
  ["week", "最近 7 天"],
  ["month", "本月"],
  ["custom", "自定义"],
];

// Existing date controls do not include a range picker and no date library is installed.
// Native date inputs handle editing; this only derives local calendar-day boundaries.
function dateInputValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateRange(period: Period, from: string, to: string, today: string) {
  const start = new Date(`${period === "custom" ? from : today}T00:00:00`);
  const end = new Date(`${period === "custom" ? to : today}T00:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  if (period === "yesterday") start.setDate(start.getDate() - 1);
  if (period === "week") start.setDate(start.getDate() - 6);
  if (period === "month") start.setDate(1);
  if (period !== "yesterday") end.setDate(end.getDate() + 1);
  if (end <= start) return null;
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: `${dateInputValue(start)} — ${dateInputValue(new Date(end.getTime() - 1))}`,
  };
}

const total = (row: TrafficHistoryRow) => BigInt(row.rxBytes) + BigInt(row.txBytes);

export function HistoryView({
  active,
  scope,
  icons,
}: {
  active: boolean;
  scope: TrafficScope;
  icons: Record<string, string>;
}) {
  const [period, setPeriod] = useState<Period>("today");
  const [today, setToday] = useState(() => dateInputValue(new Date()));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TrafficCategory | "all">("all");
  const [sort, setSort] = useState<Sort>("total");
  const [ascending, setAscending] = useState(false);
  const [result, setResult] = useState<{ key: string; value: TrafficHistoryResult }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map<string, { at: number; value: TrafficHistoryResult }>());
  const range = useMemo(
    () => dateRange(period, customFrom, customTo, today),
    [period, customFrom, customTo, today],
  );
  const key = range ? `${scope}:${range.from}:${range.to}` : "";
  const from = range?.from;
  const to = range?.to;
  useEffect(() => {
    const timer = setInterval(() => setToday(dateInputValue(new Date())), 60_000);
    const stop = client.onPrepareStop(() => {
      clearInterval(timer);
      return { ok: true };
    });
    return () => {
      clearInterval(timer);
      stop();
    };
  }, []);
  useEffect(() => {
    if (!active || !from || !to) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onPrepareStop(() => {
      disposed = true;
      clearTimeout(timer);
      return { ok: true };
    });
    const load = async () => {
      setError(undefined);
      const cached = cache.current.get(key);
      if (cached) setResult({ key, value: cached.value });
      if (cached && Date.now() - cached.at < 30_000) {
        timer = setTimeout(() => void load(), Math.max(1000, 30_000 - (Date.now() - cached.at)));
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const value = await request<TrafficHistoryResult>("history", { from, to, scope });
        if (disposed) return;
        cache.current.set(key, { at: Date.now(), value });
        setResult({ key, value });
      } catch (value) {
        if (!disposed) setError(errorMessage(value));
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void load(), 30_000);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      stop();
    };
  }, [active, from, to, scope, key, revision]);
  const data = result?.key === key ? result.value : undefined;
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (data?.rows ?? [])
      .filter(
        (row) =>
          (!search || `${row.name} ${row.executable}`.toLocaleLowerCase().includes(search)) &&
          (category === "all" || row.category === category),
      )
      .sort((a, b) => {
        let compare: number;
        if (sort === "name" || sort === "category") {
          const av = sort === "name" ? a.name : categoryLabels[a.category];
          const bv = sort === "name" ? b.name : categoryLabels[b.category];
          compare = av.localeCompare(bv, "zh-CN");
        } else {
          const av =
            sort === "rx" ? BigInt(a.rxBytes) : sort === "tx" ? BigInt(a.txBytes) : total(a);
          const bv =
            sort === "rx" ? BigInt(b.rxBytes) : sort === "tx" ? BigInt(b.txBytes) : total(b);
          compare = av === bv ? 0 : av > bv ? 1 : -1;
        }
        return (ascending ? compare : -compare) || a.appId.localeCompare(b.appId);
      });
  }, [data?.rows, query, category, sort, ascending]);
  const selectSort = (value: Sort) => {
    setAscending(sort === value ? !ascending : value === "name" || value === "category");
    setSort(value);
  };
  const heading = (value: Sort, label: string) => (
    <SortLabel active={sort === value} ascending={ascending} onClick={() => selectSort(value)}>
      {label}
    </SortLabel>
  );
  const clearHistory = async () => {
    setClearing(true);
    try {
      await request("history.clear", { scope, confirmed: true });
      cache.current.clear();
      setResult(undefined);
      setConfirmClear(false);
      setRevision((value) => value + 1);
      setError(undefined);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setClearing(false);
    }
  };
  return (
    <section className="traffic-view" hidden={!active} aria-label="历史流量">
      <div className="traffic-summary">
        <span className="traffic-summary-item">
          下载总量{" "}
          <strong className="traffic-download">
            {formatTrafficBytes(data?.totals.rxBytes ?? null)}
          </strong>
        </span>
        <span className="traffic-summary-item">
          上传总量{" "}
          <strong className="traffic-upload">
            {formatTrafficBytes(data?.totals.txBytes ?? null)}
          </strong>
        </span>
        <span className="traffic-summary-note">{range?.label ?? "请选择有效日期范围"}</span>
      </div>
      <div className="traffic-toolbar traffic-date-toolbar">
        <div className="traffic-periods" aria-label="历史日期范围">
          {periods.map(([value, label]) => (
            <Button
              key={value}
              size="xs"
              variant={period === value ? "secondary" : "ghost"}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {period === "custom" && (
          <div className="traffic-date-range">
            <Input
              type="date"
              aria-label="开始日期"
              value={customFrom}
              max={customTo || today}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <span className="traffic-muted">至</span>
            <Input
              type="date"
              aria-label="结束日期"
              value={customTo}
              min={customFrom}
              max={today}
              onChange={(event) => setCustomTo(event.target.value)}
            />
          </div>
        )}
        <span className="traffic-toolbar-end">
          {loading && data ? "后台更新中…" : "含已退出的程序"}
        </span>
      </div>
      <div className="traffic-toolbar">
        <TrafficSearch value={query} onChange={setQuery} />
        <CategoryFilter value={category} onChange={setCategory} />
        <Button
          variant="ghost"
          size="xs"
          disabled={loading || !range}
          onClick={() => {
            cache.current.delete(key);
            setRevision((value) => value + 1);
          }}
        >
          刷新
        </Button>
        <span className="traffic-toolbar-end">
          {scope === "machine" ? "已授权整机" : "当前账户"}进程记录
        </span>
      </div>
      {data && range && ((data.resolutionSec ?? 0) >= 86400 || data.from !== range.from) && (
        <div className="traffic-notice">
          <Alert>
            <AlertDescription
              title={
                (data.resolutionSec ?? 0) >= 86400
                  ? "按 UTC 日聚合，以下为对应的本地时间。"
                  : "已按历史数据粒度对齐。"
              }
            >
              {`统计范围：${new Date(data.from).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} — ${new Date(data.to).toLocaleString("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
            </AlertDescription>
          </Alert>
        </div>
      )}
      {(error || !range) && (
        <div className="traffic-notice">
          <Alert variant={error ? "destructive" : "default"}>
            <AlertDescription>{error || "开始日期须早于或等于结束日期。"}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="traffic-table-area">
        <Table className="traffic-table">
          <TableHeader>
            <TableRow>
              <TableHead
                aria-sort={sort === "name" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {heading("name", "程序名称")}
              </TableHead>
              <TableHead
                aria-sort={
                  sort === "category" ? (ascending ? "ascending" : "descending") : undefined
                }
              >
                {heading("category", "程序类别")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={sort === "rx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {heading("rx", "下载流量")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={sort === "tx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {heading("tx", "上传流量")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={sort === "total" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {heading("total", "合计")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.appId}>
                <TableCell>
                  <ProgramName
                    name={row.name}
                    executable={row.executable}
                    icon={row.iconId ? icons[row.iconId] : undefined}
                  />
                </TableCell>
                <TableCell className="traffic-muted">{categoryLabels[row.category]}</TableCell>
                <TableCell className="traffic-numeric traffic-download">
                  {formatTrafficBytes(row.rxBytes)}
                </TableCell>
                <TableCell className="traffic-numeric traffic-upload">
                  {formatTrafficBytes(row.txBytes)}
                </TableCell>
                <TableCell className="traffic-numeric">
                  {formatTrafficBytes(total(row).toString())}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!rows.length && (
          <TrafficEmpty
            title={
              loading && !data
                ? "正在读取历史记录"
                : error && !data
                  ? "历史记录暂不可用"
                  : "没有符合条件的流量记录"
            }
          >
            {data ? "调整日期或筛选条件。" : undefined}
          </TrafficEmpty>
        )}
      </div>
      <footer className="traffic-footer">
        <span title={data?.message}>
          {rows.length} 个程序 · {data ? coverageLabels[data.coverage] : "等待记录"}
          {data?.resolutionSec
            ? ` · 每 ${data.resolutionSec >= 86400 ? `${data.resolutionSec / 86400} 天` : data.resolutionSec >= 3600 ? `${data.resolutionSec / 3600} 小时` : data.resolutionSec >= 60 ? `${data.resolutionSec / 60} 分钟` : `${data.resolutionSec} 秒`}统计`
            : ""}
          {data?.durableThrough
            ? ` · 最近保存 ${new Date(data.durableThrough).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
            : ""}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={clearing || !data}
          onClick={() => setConfirmClear(true)}
        >
          清空历史记录
        </Button>
      </footer>
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              清空{scope === "machine" ? "整机" : "当前账户"}流量历史？
            </AlertDialogTitle>
            <AlertDialogDescription>
              该范围所有日期的历史记录都会被删除，删除后无法恢复。采集会继续记录后续流量。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={clearing}
              onClick={() => void clearHistory()}
            >
              {clearing ? "正在清空…" : "清空记录"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
