import path from "node:path";

/**
 * AMD Radeon 780M / driver 32.0.13032.11 aborts during D3D11 initialization when
 * a packaged Electron process inherits a WSL UNC working directory. Changing
 * only the working directory to a local path removes the failure. Keep GPU
 * acceleration and every sandbox enabled; application storage uses absolute paths.
 */
export function initializeWindowsRuntime(): void {
  if (process.platform === "win32") process.chdir(path.dirname(process.execPath));
}
