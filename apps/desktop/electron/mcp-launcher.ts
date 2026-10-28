import { spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";
import { probePipe } from "./mcp-server.js";

// 打包后主进程在 asar 内，而 ELECTRON_RUN_AS_NODE 的纯 Node 无法读 asar，
// 中继脚本通过 asarUnpack 落在 app.asar.unpacked，这里做路径翻译。
function unpacked(file: string): string {
  return file.replace("app.asar" + path.sep, `app.asar.unpacked${path.sep}`);
}

export interface McpLauncherOptions {
  exe: string;
  /** dist-electron/electron 目录（relay.js 同目录） */
  here: string;
  configDir: string;
}

/**
 * `spark233.exe --mcp` 入口：管道无人监听时先拉起主应用，再用
 * ELECTRON_RUN_AS_NODE 起纯 Node 中继并把本进程的 stdio 交给它。
 * 返回进程退出码。
 */
export async function runMcpLauncher(options: McpLauncherOptions): Promise<number> {
  const relay = unpacked(path.join(options.here, "mcp-relay.js"));
  if (!(await probePipe(options.configDir))) {
    // 未运行则拉起主应用；中继自带 15 秒重试等待其就绪。
    // 开发模式下 electron.exe 需要显式指定应用目录，安装包则自带。
    const args = app.isPackaged ? [] : [app.getAppPath()];
    spawn(options.exe, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  const child = spawn(process.execPath, [relay, options.configDir], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  return new Promise((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(`spark233 MCP 中继启动失败: ${String(error)}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
