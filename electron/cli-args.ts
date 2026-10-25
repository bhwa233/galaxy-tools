export type CliCommand = "new" | "show" | "hide" | "toggle" | "list" | "exit";

export interface ParsedCliArgs {
  command?: CliCommand;
  mcp: boolean;
}

const COMMAND_FLAGS: Record<string, CliCommand> = {
  "--new": "new",
  "--show": "show",
  "--hide": "hide",
  "--toggle": "toggle",
  "--list": "list",
  "--exit": "exit",
};

// 第一个识别到的指令生效；--mcp 属于独立运行模式，不算指令。
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: CliCommand | undefined;
  let mcp = false;
  for (const arg of argv) {
    if (arg === "--mcp") mcp = true;
    else if (!command && COMMAND_FLAGS[arg]) command = COMMAND_FLAGS[arg];
  }
  return { command, mcp };
}
