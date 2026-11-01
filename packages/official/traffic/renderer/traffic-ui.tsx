import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@spark233/ui/components";
import { createPluginClient } from "../../../sdk/src/browser.js";
import type { JsonValue } from "../../../sdk/src/index.js";
import type { TrafficCategory, TrafficCoverage, TrafficProcessRow } from "../traffic-contract";

export const client = createPluginClient();

const invoke = (commandId: string, parameters?: JsonValue) =>
  client.capability("node.backend", "invoke", {
    commandId,
    ...(parameters === undefined ? {} : { parameters }),
  });

type TrafficPage = Record<string, unknown> & {
  nextCursor?: string | null;
  processes?: TrafficProcessRow[];
  rows?: JsonValue[];
  icons?: Record<string, string>;
  iconChunks?: Record<string, string[]>;
};

export async function request<T>(commandId: string, parameters?: JsonValue): Promise<T> {
  const value = await invoke(commandId, parameters);
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as T;
  const first = value as TrafficPage;
  const merged: TrafficPage = { ...first };
  const processes = new Map<string, TrafficProcessRow>();
  const rows: JsonValue[] = [];
  const icons: Record<string, string> = {};
  const chunks = new Map<string, string[]>();
  const append = (page: TrafficPage) => {
    for (const row of page.processes ?? []) {
      const existing = processes.get(row.appId);
      if (!existing) {
        processes.set(row.appId, { ...row, instances: [...row.instances] });
      } else {
        // Split groups repeat their aggregate counters; only instances are fragments.
        const ids = new Set(existing.instances.map((instance) => instance.id));
        for (const instance of row.instances) {
          if (!ids.has(instance.id)) {
            existing.instances.push(instance);
            ids.add(instance.id);
          }
        }
      }
    }
    rows.push(...(page.rows ?? []));
    Object.assign(icons, page.icons);
    for (const [id, fragment] of Object.entries(page.iconChunks ?? {})) {
      const previous = chunks.get(id);
      if (previous) previous.push(...fragment);
      else chunks.set(id, [...fragment]);
    }
  };
  append(first);
  let cursor = first.nextCursor;
  const cursors = new Set<string>();
  const input =
    parameters && typeof parameters === "object" && !Array.isArray(parameters) ? parameters : {};
  while (cursor) {
    if (cursors.has(cursor)) throw new Error("流量分页游标重复，请重新查询。");
    cursors.add(cursor);
    const page = (await invoke(commandId, { ...input, cursor })) as TrafficPage;
    append(page);
    cursor = page.nextCursor;
  }
  if (Array.isArray(first.processes)) merged.processes = [...processes.values()];
  if (Array.isArray(first.rows)) merged.rows = rows;
  for (const [id, fragment] of chunks) icons[id] = fragment.join("");
  if (first.icons || first.iconChunks || Array.isArray(first.processes)) merged.icons = icons;
  delete merged.iconChunks;
  if ("nextCursor" in first) merged.nextCursor = null;
  return merged as T;
}

export const coverageLabels: Record<TrafficCoverage, string> = {
  warming: "建立基线中",
  complete: "采样正常",
  gap: "采样有缺口",
  paused: "已暂停",
  unavailable: "采集不可用",
};

export const categoryLabels: Record<TrafficCategory, string> = {
  application: "应用程序",
  system: "系统程序",
  unknown: "未识别",
};

export function ProgramName({
  name,
  executable,
  icon,
  prefix,
}: {
  name: string;
  executable: string;
  icon?: string;
  prefix?: ReactNode;
}) {
  const file = executable.split(/[\\/]/).pop() || "路径不可用";
  return (
    <div className="traffic-app">
      {prefix}
      {icon ? (
        <img className="traffic-icon" src={icon} alt="" draggable={false} />
      ) : (
        <span className="traffic-icon traffic-icon-fallback" aria-hidden="true">
          {(name || file).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="traffic-app-copy" title={executable || name}>
        <strong>{name || file}</strong>
        <small>{file}</small>
      </span>
    </div>
  );
}

export function TrafficSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="traffic-search">
      <Search size={14} aria-hidden="true" />
      <Input
        type="search"
        aria-label="搜索程序名称或文件名"
        placeholder="搜索程序名称或文件名"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function CategoryFilter({
  value,
  onChange,
}: {
  value: TrafficCategory | "all";
  onChange: (value: TrafficCategory | "all") => void;
}) {
  return (
    <select
      className="traffic-select"
      aria-label="筛选程序类别"
      value={value}
      onChange={(event) => onChange(event.target.value as TrafficCategory | "all")}
    >
      <option value="all">全部程序类别</option>
      {Object.entries(categoryLabels).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function SortLabel({
  children,
  active,
  ascending,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  ascending: boolean;
  onClick: () => void;
}) {
  const Icon = active ? (ascending ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button type="button" className="traffic-sort" data-active={active} onClick={onClick}>
      {children}
      <Icon size={12} aria-hidden="true" />
    </button>
  );
}

export function TrafficEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="traffic-empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function errorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  const detail = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
  if (/row-too-large|response-too-large|metadata-too-large/.test(detail))
    return "历史查询返回的数据过大，请更新流量采集服务后重试。";
  if (/history-query-too-large-narrow-range/.test(detail))
    return "查询范围过大，请缩短日期范围后重试。";
  if (/cursor-expired|query-capacity-reached/.test(detail)) return "查询已过期，请刷新重试。";
  return detail;
}
