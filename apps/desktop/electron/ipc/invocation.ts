import type { BrowserWindow } from "electron";
import type { z } from "zod";
import type { CommandName } from "../../shared/command-policies.js";
import type { commandSchemas } from "../../shared/command-schemas.js";
import type { Layout } from "../runtime.js";
import type { FileGrants } from "../security.js";
interface InvocationContext {
  win: BrowserWindow;
  layout: Layout;
  grants: FileGrants;
  preparationWrite: boolean;
  label: string;
}
export type CommandInvocation = {
  [C in CommandName]: InvocationContext & {
    command: C;
    args: Exclude<z.output<(typeof commandSchemas)[C]>, undefined>;
  };
}[CommandName];
export type CommandHandler = (input: CommandInvocation) => Promise<unknown>;
