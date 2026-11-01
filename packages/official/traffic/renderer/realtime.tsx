import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@spark233/ui/components";
import { Checkbox } from "../../../../apps/desktop/src/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../apps/desktop/src/components/ui/table";
import {
  formatTrafficRate,
  formatTrafficBytes,
  type TrafficCategory,
  type TrafficProcessRow,
  type TrafficState,
} from "../traffic-contract";
import {
  CategoryFilter,
  ProgramName,
  SortLabel,
  TrafficEmpty,
  TrafficSearch,
  categoryLabels,
} from "./traffic-ui";

type Sort = "name" | "category" | "rx" | "tx" | "runRx" | "runTx" | "connections";
const sortValues = {
  name: (row: TrafficProcessRow) => row.name,
  category: (row: TrafficProcessRow) => categoryLabels[row.category],
  rx: (row: TrafficProcessRow) => row.rxBytesPerSecond,
  tx: (row: TrafficProcessRow) => row.txBytesPerSecond,
  runRx: (row: TrafficProcessRow) => row.runRxBytes ?? null,
  runTx: (row: TrafficProcessRow) => row.runTxBytes ?? null,
  connections: (row: TrafficProcessRow) => row.tcpConnections,
};

export function RealtimeView({
  state,
  active,
  onConnections,
}: {
  state?: TrafficState;
  active: boolean;
  onConnections: (row: TrafficProcessRow) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TrafficCategory | "all">("all");
  const [onlyActive, setOnlyActive] = useState(false);
  const [sort, setSort] = useState<Sort>("rx");
  const [ascending, setAscending] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<string[]>([]);
  const previousSort = useRef("");
  const freezeOrder =
    hovered || focused || Boolean(state?.processes.some((row) => expanded.has(row.id)));
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (state?.processes ?? [])
      .filter(
        (row) =>
          (!search || `${row.name} ${row.executable}`.toLocaleLowerCase().includes(search)) &&
          (category === "all" || row.category === category) &&
          (!onlyActive || (row.rxBytesPerSecond ?? 0) > 0 || (row.txBytesPerSecond ?? 0) > 0),
      )
      .sort((a, b) => {
        const av = sortValues[sort](a);
        const bv = sortValues[sort](b);
        if (av === null) return bv === null ? a.id.localeCompare(b.id) : 1;
        if (bv === null) return -1;
        const compare =
          (sort === "runRx" || sort === "runTx") && typeof av === "string" && typeof bv === "string"
            ? BigInt(av) < BigInt(bv)
              ? -1
              : BigInt(av) > BigInt(bv)
                ? 1
                : 0
            : typeof av === "string" && typeof bv === "string"
              ? av.localeCompare(bv, "zh-CN")
              : Number(av) - Number(bv);
        return (ascending ? compare : -compare) || a.id.localeCompare(b.id);
      });
  }, [state?.processes, query, category, onlyActive, sort, ascending]);
  useEffect(() => {
    const sortKey = `${sort}:${ascending}`;
    const ids = rows.map((row) => row.id);
    const canFreeze = freezeOrder && previousSort.current === sortKey;
    previousSort.current = sortKey;
    setOrder((previous) => {
      const available = new Set(ids);
      const known = new Set(previous);
      const next = canFreeze
        ? [...previous.filter((id) => available.has(id)), ...ids.filter((id) => !known.has(id))]
        : ids;
      return next.length === previous.length && next.every((id, index) => previous[index] === id)
        ? previous
        : next;
    });
  }, [rows, freezeOrder, sort, ascending]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const orderedRows = order.length
    ? order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    : rows;
  const selectSort = (value: Sort) => {
    setAscending(sort === value ? !ascending : value === "name" || value === "category");
    setSort(value);
  };
  const sortHeading = (value: Sort, label: string) => (
    <SortLabel active={sort === value} ascending={ascending} onClick={() => selectSort(value)}>
      {label}
    </SortLabel>
  );
  return (
    <section className="traffic-view" hidden={!active} aria-label="实时流量">
      <div className="traffic-summary">
        <span className="traffic-summary-item">
          下载总速度{" "}
          <strong className="traffic-download">
            ↓ {formatTrafficRate(state?.rxBytesPerSecond ?? null)}
          </strong>
        </span>
        <span className="traffic-summary-item">
          上传总速度{" "}
          <strong className="traffic-upload">
            ↑ {formatTrafficRate(state?.txBytesPerSecond ?? null)}
          </strong>
        </span>
        <span className="traffic-summary-note">活动物理网卡总量 · 包含局域网流量</span>
      </div>
      <div className="traffic-toolbar">
        <TrafficSearch value={query} onChange={setQuery} />
        <CategoryFilter value={category} onChange={setCategory} />
        <label className="traffic-check">
          <Checkbox
            checked={onlyActive}
            onCheckedChange={(value) => setOnlyActive(Boolean(value))}
          />
          仅显示有流量的程序
        </label>
        <span className="traffic-toolbar-end">
          {freezeOrder ? "排序已暂时固定，数值继续刷新" : "每秒刷新"}
        </span>
      </div>
      <div
        className="traffic-table-area"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <Table className="traffic-table traffic-realtime-table">
          <TableHeader>
            <TableRow>
              <TableHead
                aria-sort={sort === "name" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {sortHeading("name", "程序名称")}
              </TableHead>
              <TableHead
                aria-sort={
                  sort === "category" ? (ascending ? "ascending" : "descending") : undefined
                }
              >
                {sortHeading("category", "程序类别")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={sort === "rx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {sortHeading("rx", "下载速度")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={sort === "tx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {sortHeading("tx", "上传速度")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                title="程序本次运行期间已采集的流量"
                aria-sort={sort === "runRx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {sortHeading("runRx", "本次下载")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                title="程序本次运行期间已采集的流量"
                aria-sort={sort === "runTx" ? (ascending ? "ascending" : "descending") : undefined}
              >
                {sortHeading("runTx", "本次上传")}
              </TableHead>
              <TableHead
                className="traffic-numeric"
                aria-sort={
                  sort === "connections" ? (ascending ? "ascending" : "descending") : undefined
                }
              >
                {sortHeading("connections", "TCP 连接")}
              </TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orderedRows.map((row) => (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell>
                    <ProgramName
                      name={row.name}
                      executable={row.executable}
                      icon={row.iconId ? state?.icons[row.iconId] : undefined}
                      prefix={
                        <Button
                          className="traffic-expand"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${expanded.has(row.id) ? "收起" : "展开"}${row.name}的进程`}
                          aria-expanded={expanded.has(row.id)}
                          disabled={!row.instances.length}
                          onClick={() =>
                            setExpanded((previous) => {
                              const next = new Set(previous);
                              if (next.has(row.id)) next.delete(row.id);
                              else next.add(row.id);
                              return next;
                            })
                          }
                        >
                          {expanded.has(row.id) ? (
                            <ChevronDown size={13} />
                          ) : (
                            <ChevronRight size={13} />
                          )}
                        </Button>
                      }
                    />
                  </TableCell>
                  <TableCell className="traffic-muted">{categoryLabels[row.category]}</TableCell>
                  <TableCell className="traffic-numeric traffic-download">
                    {formatTrafficRate(row.rxBytesPerSecond)}
                  </TableCell>
                  <TableCell className="traffic-numeric traffic-upload">
                    {formatTrafficRate(row.txBytesPerSecond)}
                  </TableCell>
                  <TableCell
                    className="traffic-numeric traffic-download"
                    title={row.runCoverage === "gap" ? "仅包含已采集流量" : "本次运行累计"}
                  >
                    {formatTrafficBytes(row.runRxBytes ?? null)}
                  </TableCell>
                  <TableCell
                    className="traffic-numeric traffic-upload"
                    title={row.runCoverage === "gap" ? "仅包含已采集流量" : "本次运行累计"}
                  >
                    {formatTrafficBytes(row.runTxBytes ?? null)}
                  </TableCell>
                  <TableCell
                    className="traffic-numeric"
                    title={`UDP 流：${row.udpFlows ?? "未知"}`}
                  >
                    {row.tcpConnections ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="xs" onClick={() => onConnections(row)}>
                      连接
                    </Button>
                  </TableCell>
                </TableRow>
                {expanded.has(row.id) &&
                  row.instances.map((instance) => (
                    <TableRow key={instance.id} className="traffic-instance">
                      <TableCell title={instance.executable}>
                        <span className="traffic-instance-label">
                          <span>{instance.name || row.name}</span>
                          <span className="traffic-muted">PID {instance.pid}</span>
                        </span>
                      </TableCell>
                      <TableCell className="traffic-muted">进程实例</TableCell>
                      <TableCell className="traffic-numeric traffic-download">
                        {formatTrafficRate(instance.rxBytesPerSecond)}
                      </TableCell>
                      <TableCell className="traffic-numeric traffic-upload">
                        {formatTrafficRate(instance.txBytesPerSecond)}
                      </TableCell>
                      <TableCell className="traffic-numeric traffic-download">
                        {formatTrafficBytes(instance.runRxBytes ?? null)}
                      </TableCell>
                      <TableCell className="traffic-numeric traffic-upload">
                        {formatTrafficBytes(instance.runTxBytes ?? null)}
                      </TableCell>
                      <TableCell className="traffic-numeric">
                        {instance.tcpConnections ?? "—"}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
        {!rows.length && (
          <TrafficEmpty
            title={
              !state
                ? "正在连接流量采集器"
                : state.process.status !== "collecting"
                  ? "进程流量尚未就绪"
                  : "没有符合条件的程序"
            }
          >
            {state?.process.status === "not-installed"
              ? "在上方启用进程采集。"
              : state?.process.status === "collecting"
                ? "调整搜索或筛选条件。"
                : undefined}
          </TrafficEmpty>
        )}
      </div>
      <footer className="traffic-footer">
        <span title="网卡总量与进程合计的统计范围不同。">
          {rows.length} 个程序
          {state
            ? ` · ${state.process.scope === "machine" ? "已授权整机" : "当前账户"}进程范围`
            : ""}
        </span>
        <span
          title={state?.adapters
            .map((adapter) => `${adapter.name}: ${adapter.addresses.join(", ")}`)
            .join("\n")}
        >
          {state?.adapters.length ?? 0} 张活动物理网卡
        </span>
      </footer>
    </section>
  );
}
