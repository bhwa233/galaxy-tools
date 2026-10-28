import type { BrowserWindow } from "electron";
import { commandPolicies, type CommandName } from "../../shared/command-policies.js";
import { commandSchemas } from "../../shared/command-schemas.js";
import { AppError } from "../persistence.js";

/** Validation is part of resolution, before a command can enter the mutation queue. */
export function createCommandRegistry(
  dispatch: (
    win: BrowserWindow,
    command: CommandName,
    args: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
) {
  return {
    resolve(name: string, args: unknown) {
      if (!Object.hasOwn(commandPolicies, name))
        throw new AppError("invalidCommand", `Unknown host command: ${name}`);
      const command = name as CommandName;
      const parsed = commandSchemas[command].safeParse(args);
      if (!parsed.success) throw new AppError("invalidPayload", "IPC 参数格式不合法");
      return {
        ...commandPolicies[command],
        name: command,
        run: (win: BrowserWindow) => dispatch(win, command, parsed.data ?? {}),
      };
    },
  };
}
