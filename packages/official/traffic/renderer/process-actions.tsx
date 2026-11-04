import { useState, type ReactNode } from "react";
import { Ellipsis, FolderOpen, Info, Network, SquareX } from "lucide-react";
import { Button } from "@spark233/ui/components";
import { TableCell, TableRow } from "../../../../apps/desktop/src/components/ui/table";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "../../../../apps/desktop/src/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../../../apps/desktop/src/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../../../apps/desktop/src/components/ui/alert-dialog";
import type {
  TrafficProcessAction,
  TrafficProcessInstance,
  TrafficProcessRow,
  TrafficScope,
} from "../traffic-contract";

export interface ProcessSelection {
  row: TrafficProcessRow;
  scope: TrafficScope;
  instances: Pick<TrafficProcessInstance, "id" | "pid" | "name">[];
}
interface Actions {
  onConnections: (selection: ProcessSelection) => void;
  onAction: (selection: ProcessSelection, action: TrafficProcessAction) => void;
}
function ActionItems({
  selection,
  context,
  onConnections,
  onAction,
}: Actions & { selection: ProcessSelection; context?: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return (
    <>
      <Item
        disabled={!selection.row.executable || !selection.instances.length}
        onClick={() => onAction(selection, "reveal")}
      >
        <FolderOpen />
        定位文件
      </Item>
      <Item
        disabled={!selection.row.executable || !selection.instances.length}
        onClick={() => onAction(selection, "properties")}
      >
        <Info />
        文件属性
      </Item>
      <Item disabled={!selection.instances.length} onClick={() => onConnections(selection)}>
        <Network />
        查看连接
      </Item>
      <Separator />
      <Item
        variant="destructive"
        disabled={!selection.instances.length || selection.instances.length > 256}
        onClick={() => onAction(selection, "terminate")}
      >
        <SquareX />
        {selection.instances.length > 1
          ? `结束全部进程（${selection.instances.length}）`
          : "结束进程"}
      </Item>
    </>
  );
}
export function ProcessRow({
  row,
  instance,
  scope,
  children,
  onMenuOpenChange,
  onConnections,
  onAction,
}: Actions & {
  row: TrafficProcessRow;
  instance?: TrafficProcessInstance;
  scope: TrafficScope;
  children: ReactNode;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const capture = (): ProcessSelection => {
    const targets = instance ? [instance] : row.instances;
    return {
      row: { ...row, instances: targets.map((target) => ({ ...target })) },
      scope,
      instances: targets.map(({ id, pid, name }) => ({ id, pid, name })),
    };
  };
  const [selection, setSelection] = useState<ProcessSelection>();
  const openChanged = (open: boolean) => {
    // Capture before opening: polling must never retarget a later click.
    if (open) setSelection(capture());
    onMenuOpenChange(open);
  };
  const current = selection ?? capture();
  const actions = { onConnections, onAction };
  return (
    <ContextMenu onOpenChange={openChanged}>
      <ContextMenuTrigger
        render={<TableRow className={instance ? "traffic-instance" : undefined} />}
      >
        {children}
        <TableCell>
          <div className="traffic-row-actions">
            <Button variant="ghost" size="xs" onClick={() => onConnections(capture())}>
              连接
            </Button>
            <DropdownMenu onOpenChange={openChanged}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`更多操作 · ${instance ? `${instance.name} · PID ${instance.pid}` : row.name}`}
                  />
                }
              >
                <Ellipsis size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <ActionItems selection={current} {...actions} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ActionItems selection={current} context {...actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
export function TerminateDialog({
  selection,
  busy,
  onCancel,
  onConfirm,
}: {
  selection: ProcessSelection;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {selection.instances.length > 1
              ? `结束全部 ${selection.instances.length} 个进程？`
              : "结束此进程？"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            将结束 {selection.row.name} 的以下进程，未保存的内容可能丢失。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="traffic-termination-targets">
          {selection.instances.map((instance) => (
            <li key={instance.id}>
              <span>{instance.name}</span>
              <span>PID {instance.pid}</span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? "正在结束…" : "确认结束"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
