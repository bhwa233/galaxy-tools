/* eslint-disable no-control-regex -- Reject control characters in Windows application identities. */
import { app, shell, clipboard, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { AppError, canonical, inside } from "../../persistence.js";
import type { JsonValue } from "@spark233/sdk";
import { ordinaryDocument, sameApplicationEntryPath } from "../../application-entries.js";

const launchSchema = z.strictObject({
  action: z.enum(["launchApplication", "revealApplication", "copyApplicationPath"]),
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("custom"),
      path: z.string().min(1).max(32768),
      args: z
        .array(
          z
            .string()
            .max(4096)
            .refine((argument) => !argument.includes("\0")),
        )
        .max(64),
      cwd: z.string().max(32768),
    }),
    z.strictObject({ kind: z.literal("shortcut"), path: z.string().min(1).max(4096) }),
    z.strictObject({ kind: z.literal("document"), path: z.string().min(1).max(32768) }),
    z.strictObject({ kind: z.literal("directory"), path: z.string().min(1).max(32768) }),
    z.strictObject({
      kind: z.literal("app"),
      appUserModelId: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\x00-\x1f]+$/),
    }),
  ]),
});
export type IndexedApplicationLaunch = z.infer<typeof launchSchema>;

/** Only consume the trusted official backend's launch response, after it has
 * resolved a host-session selection ID; never accept renderer launch targets. */
export async function launchIndexedApplication(value: unknown): Promise<void> {
  return performIndexedApplicationAction(value);
}
export async function performIndexedApplicationAction(value: unknown): Promise<void> {
  if (process.platform !== "win32") throw new Error("Application launch requires Windows");
  const { action, target } = launchSchema.parse(value);
  let location: string;
  if (target.kind === "custom") {
    if (
      !path.isAbsolute(target.path) ||
      /[\x00-\x1f]/.test(target.path) ||
      !/\.(?:exe|lnk|url)$/i.test(target.path)
    )
      throw new AppError("invalidApplication", "自定义应用路径不合法");
    const real = fs.realpathSync(target.path);
    if (!fs.statSync(real).isFile() || !/\.(?:exe|lnk|url)$/i.test(real))
      throw new AppError("invalidApplication", "自定义应用文件不可用");
    if (/\.exe$/i.test(real)) {
      if (action === "copyApplicationPath") {
        clipboard.writeText(real);
        return;
      }
      if (action === "revealApplication") {
        shell.showItemInFolder(real);
        return;
      }
      if (
        target.args.reduce((length, argument) => length + argument.length, 0) > 24000 ||
        (target.cwd && (!path.isAbsolute(target.cwd) || /[\x00-\x1f]/.test(target.cwd)))
      )
        throw new AppError("invalidApplication", "应用参数或工作目录不合法");
      const cwd = target.cwd ? fs.realpathSync(target.cwd) : path.dirname(real);
      if (!fs.statSync(cwd).isDirectory())
        throw new AppError("invalidApplication", "应用工作目录不可用");
      // Node quotes each original argv element for CreateProcess. No shell,
      // command-line interpolation, or executable supplied by search input.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(real, target.args, {
          cwd,
          shell: false,
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return;
    }
    if (target.args.length || target.cwd)
      throw new AppError("invalidApplication", "快捷方式使用其自带参数和工作目录");
    location = real;
  } else if (target.kind === "document" || target.kind === "directory") {
    if (!path.isAbsolute(target.path) || /[\x00-\x1f]/.test(target.path))
      throw new AppError("invalidApplication", "快捷入口路径不合法");
    const real = fs.realpathSync(target.path);
    const metadata = fs.statSync(real);
    if (
      !sameApplicationEntryPath(real, target.path) ||
      (target.kind === "directory"
        ? !metadata.isDirectory()
        : !metadata.isFile() || !ordinaryDocument(target.path) || !ordinaryDocument(real))
    )
      throw new AppError(
        "applicationUnavailable",
        "快捷入口已移动、删除或类型发生变化，请重新选择",
      );
    location = real;
  } else if (target.kind === "shortcut") {
    const roots = [process.env.APPDATA, process.env.ProgramData]
      .filter((root): root is string => !!root)
      .map((root) => canonical(path.join(root, "Microsoft", "Windows", "Start Menu", "Programs")));
    if (!path.isAbsolute(target.path) || !/\.(?:lnk|url)$/i.test(target.path))
      throw new AppError("invalidApplication", "应用快捷方式不合法");
    const real = fs.realpathSync(target.path);
    if (
      !roots.some((root) => inside(root, real)) ||
      !fs.statSync(real).isFile() ||
      !/\.(?:lnk|url)$/i.test(real)
    )
      throw new AppError("invalidApplication", "应用快捷方式超出开始菜单范围");
    location = real;
  } else {
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'
$packages=@{}; if(Get-Command Get-AppxPackage -ErrorAction SilentlyContinue){Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {$packages[$_.PackageFamilyName]=$_.InstallLocation}}
@(Get-StartApps | ForEach-Object { $location=''; if($_.AppID -match '!'){$location=$packages[($_.AppID -split '!')[0]]} elseif([IO.Path]::IsPathRooted($_.AppID)){$location=$_.AppID}; [PSCustomObject]@{id=$_.AppID;location=$location} }) | ConvertTo-Json -Compress`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const record = z.object({ id: z.string(), location: z.string().nullish() });
    const ids = z
      .union([z.array(record), record, z.null()])
      .parse(JSON.parse(output.replace(/^\uFEFF/, "") || "[]"));
    const registered = (Array.isArray(ids) ? ids : ids ? [ids] : []).find(
      (entry) => entry.id === target.appUserModelId,
    );
    if (!registered)
      throw new AppError("applicationUnavailable", "该应用已不在 Windows 注册列表中，请重新搜索");
    if (action === "copyApplicationPath") {
      clipboard.writeText(target.appUserModelId);
      return;
    }
    if (action === "revealApplication") {
      if (
        registered.location &&
        path.isAbsolute(registered.location) &&
        fs.existsSync(registered.location)
      ) {
        const real = fs.realpathSync(registered.location);
        if (fs.statSync(real).isDirectory()) {
          const failure = await shell.openPath(real);
          if (failure) throw new AppError("applicationLaunchFailed", failure);
        } else shell.showItemInFolder(real);
        return;
      }
      // Some registered applications have no filesystem target. Their location
      // is Windows' Applications folder; never turn an AppID into a command.
      const failure = await shell.openPath("shell:AppsFolder");
      if (failure) throw new AppError("applicationLaunchFailed", failure);
      return;
    }
    location = `shell:AppsFolder\\${target.appUserModelId}`;
  }
  if (action === "copyApplicationPath") {
    clipboard.writeText(location);
    return;
  }
  if (action === "revealApplication") {
    shell.showItemInFolder(location);
    return;
  }
  // Shell receives an admitted document/directory, original shortcut, or a
  // live-verified application ID. Document/directory payloads cannot carry argv.
  // Reconstructing executable commands would lose shortcut args and cwd.
  const failure = await shell.openPath(location);
  if (failure) throw new AppError("applicationLaunchFailed", failure);
}

const applicationIcons = new Map<string, { version: string; icon: string }>();
let iconGeneration = 0;
export function clearApplicationIconCache(): void {
  iconGeneration++;
  applicationIcons.clear();
}
/** Only the official backend provides icon paths. Renderers receive bounded PNG
 * data, never a privileged file endpoint or a path to load through Chromium. */
export async function decorateApplicationResults(value: unknown): Promise<JsonValue> {
  const generation = iconGeneration;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    return value as JsonValue;
  const items = await Promise.all(
    value.items.slice(0, 100).map(async (entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("Invalid application result");
      const { iconPath, ...item } = entry as Record<string, unknown>;
      if (typeof iconPath !== "string" || !path.isAbsolute(iconPath)) return item;
      try {
        const real = fs.realpathSync(iconPath),
          metadata = fs.statSync(real);
        const version = `${metadata.mtimeMs}:${metadata.size}`;
        let icon = applicationIcons.get(real);
        if (!icon || icon.version !== version) {
          const image =
            /\.(?:png|ico)$/i.test(real) && metadata.size <= 2 * 1024 * 1024
              ? nativeImage.createFromPath(real).resize({ width: 32, height: 32 })
              : await app.getFileIcon(real, { size: "small" });
          const data = image.toDataURL();
          if (generation !== iconGeneration) return item;
          if (!data.startsWith("data:image/png;base64,") || data.length > 32768) return item;
          icon = { version, icon: data };
          if (applicationIcons.size >= 256)
            applicationIcons.delete(applicationIcons.keys().next().value!);
          applicationIcons.set(real, icon);
        }
        return { ...item, icon: icon.icon };
      } catch {
        return item;
      }
    }),
  );
  return JSON.parse(JSON.stringify({ ...value, items })) as JsonValue;
}
