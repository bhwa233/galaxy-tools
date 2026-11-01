import { useEffect, useState } from "react";
import { Alert, AlertDescription, Button } from "@spark233/ui/components";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../../apps/desktop/src/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../apps/desktop/src/components/ui/table";
import type {
  TrafficConnectionsResult,
  TrafficProcessRow,
  TrafficScope,
} from "../traffic-contract";
import { TrafficEmpty, client, coverageLabels, errorMessage, request } from "./traffic-ui";

export function ConnectionsDialog({
  row,
  scope,
  onClose,
}: {
  row: TrafficProcessRow;
  scope: TrafficScope;
  onClose: () => void;
}) {
  const [data, setData] = useState<TrafficConnectionsResult>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onPrepareStop(() => {
      disposed = true;
      clearTimeout(timer);
      return { ok: true };
    });
    const load = async () => {
      setLoading(true);
      try {
        const value = await request<TrafficConnectionsResult>("connections", {
          appId: row.appId,
          scope,
        });
        if (!disposed) {
          setData(value);
          setError(undefined);
        }
      } catch (value) {
        if (!disposed) setError(errorMessage(value));
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void load(), 2000);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      stop();
    };
  }, [row.appId, scope, revision]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="traffic-connection-dialog">
        <DialogHeader>
          <DialogTitle>{row.name} · 网络连接</DialogTitle>
          <DialogDescription>
            显示{scope === "machine" ? "已授权整机" : "当前账户"}范围内的 TCP 连接和 UDP 端点。UDP
            本地端点没有固定远端地址。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="traffic-connection-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PID</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>本地地址</TableHead>
                <TableHead>远端地址</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.rows.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell>{connection.pid}</TableCell>
                  <TableCell
                    title={
                      connection.kind === "udp-local"
                        ? "UDP 本地端点"
                        : connection.kind === "udp-observed"
                          ? "实际观察到的 UDP 远端"
                          : "TCP 连接"
                    }
                  >
                    {connection.protocol}
                  </TableCell>
                  <TableCell>
                    {connection.localAddress.includes(":")
                      ? `[${connection.localAddress}]`
                      : connection.localAddress}
                    :{connection.localPort}
                  </TableCell>
                  <TableCell>
                    {connection.remoteAddress === null
                      ? "—"
                      : `${connection.remoteAddress.includes(":") ? `[${connection.remoteAddress}]` : connection.remoteAddress}:${connection.remotePort ?? "—"}`}
                  </TableCell>
                  <TableCell>
                    {connection.kind === "udp-local" ? "本地端点" : connection.state || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data?.rows.length && (
            <TrafficEmpty title={!data && loading ? "正在读取连接" : "当前没有可显示的连接"}>
              {data?.message || "连接可能已经关闭，或不在当前授权范围内。"}
            </TrafficEmpty>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="traffic-connection-status">
            {data
              ? `${data.rows.length} 个连接 / 端点 · ${coverageLabels[data.coverage]}`
              : "等待连接数据"}
            {data?.message ? ` · ${data.message}` : ""}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
