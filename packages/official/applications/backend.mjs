/* eslint-disable no-control-regex -- Reject control characters in Windows application identities. */
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createPinyinMatcher } from "./pinyin.mjs";

const CACHE_MS = 60_000;
const MAX_ENTRIES = 20_000;
const normalize = (text) => text.normalize("NFKC").toLocaleLowerCase().trim();
const idFor = (kind, identity) => createHash("sha256").update(`${kind}\0${identity}`).digest("hex");
const menuRoots = () =>
  [
    process.env.APPDATA &&
      path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.ProgramData &&
      path.join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter(Boolean);
const registeredScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$packages = @{}
if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) { Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object { $packages[$_.PackageFamilyName] = $_.InstallLocation } }
@(Get-StartApps | ForEach-Object {
  $location = ''; $icon = ''
  if ($_.AppID -match '!') {
    $location = $packages[($_.AppID -split '!')[0]]
    if ($location) {
      try {
        [xml]$manifest = Get-Content -LiteralPath (Join-Path $location 'AppxManifest.xml') -Raw
        $visual = $manifest.SelectSingleNode("//*[local-name()='Application' and @Id='$(($_.AppID -split '!')[1])']/*[local-name()='VisualElements']")
        if ($visual -and $visual.Square44x44Logo) {
          $candidate = Join-Path $location $visual.Square44x44Logo
          if (Test-Path -LiteralPath $candidate) { $icon = $candidate }
          else { $folder = Split-Path $candidate; $stem = [IO.Path]::GetFileNameWithoutExtension($candidate); $icon = (Get-ChildItem -LiteralPath $folder -Filter "$stem*.png" -File -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
        }
      } catch {}
    }
  } elseif ([IO.Path]::IsPathRooted($_.AppID) -and (Test-Path -LiteralPath $_.AppID -PathType Leaf)) { $location = $_.AppID; $icon = $_.AppID }
  [PSCustomObject]@{ Name=$_.Name; AppID=$_.AppID; Location=$location; Icon=$icon }
}) | ConvertTo-Json -Compress -Depth 3
`;
const uninstallEntry = (title) =>
  /(?:^|[\s_.-])(?:uninstall|uninstaller)(?:$|[\s_.-])|卸载|解除安装/i.test(title);

/** Standalone backend: reuse the Windows shell's registered application list and
 * original shortcuts. No shortcut target/arguments are parsed or reconstructed. */
export default function applicationsPlugin(lifetime) {
  if (process.platform !== "win32") throw new Error("Application search requires Windows");
  const controller = new AbortController();
  const pinyin = createPinyinMatcher({ cacheDir: lifetime.cacheDir, signal: controller.signal });
  const abort = () => controller.abort();
  lifetime.signal.addEventListener("abort", abort, { once: true });
  let entries = new Map();
  let refreshedAt = 0;
  let inventoryRevision = 0;
  let refreshing;
  let warnings = [];
  let sources = { shortcuts: 0, registeredApplications: 0, appx: 0 };
  let stopping = false;
  let currentQuery;
  const customFile = path.join(lifetime.dataDir, "custom-entries.json");
  let customEntries = [];
  let settingsLoaded;
  let saving = Promise.resolve();
  const watchers = [];
  const invalidate = () => {
    inventoryRevision++;
    refreshedAt = 0;
  };
  for (const directory of menuRoots()) {
    try {
      const watcher = watch(directory, { recursive: true }, invalidate);
      watcher.on("error", invalidate);
      watchers.push(watcher);
    } catch {
      /* Missing menus remain discoverable by refresh/periodic calibration. */
    }
  }
  const calibration = setInterval(invalidate, CACHE_MS);
  calibration.unref();

  function validateEntries(value) {
    if (!Array.isArray(value) || value.length > 200)
      throw new Error("Custom applications must be a list of at most 200 entries");
    const ids = new Set();
    return value.map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(entry.id) ||
        ids.has(entry.id) ||
        typeof entry.title !== "string" ||
        !entry.title.trim() ||
        entry.title.length > 160 ||
        typeof entry.path !== "string" ||
        !path.isAbsolute(entry.path) ||
        entry.path.length > 32768 ||
        !/\.(?:exe|lnk|url)$/i.test(entry.path) ||
        /[\x00-\x1f]/.test(entry.path) ||
        !Array.isArray(entry.args) ||
        entry.args.length > 64 ||
        entry.args.some(
          (argument) =>
            typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"),
        ) ||
        entry.args.reduce((length, argument) => length + argument.length, 0) > 24000 ||
        typeof entry.cwd !== "string" ||
        entry.cwd.length > 32768 ||
        /[\x00-\x1f]/.test(entry.cwd) ||
        (entry.cwd && !path.isAbsolute(entry.cwd))
      )
        throw new Error("Invalid custom application name, path, arguments, or working directory");
      if (!/\.exe$/i.test(entry.path) && (entry.args.length || entry.cwd))
        throw new Error("Shortcut entries retain their own arguments and working directory");
      ids.add(entry.id);
      return {
        id: entry.id,
        title: entry.title.trim(),
        path: path.resolve(entry.path),
        args: [...entry.args],
        cwd: entry.cwd ? path.resolve(entry.cwd) : "",
      };
    });
  }
  async function loadSettings() {
    if (!settingsLoaded)
      settingsLoaded = (async () => {
        try {
          if ((await fs.stat(customFile)).size > 2 * 1024 * 1024)
            throw new Error("Custom application settings are too large");
          const saved = JSON.parse(await fs.readFile(customFile, "utf8"));
          if (saved.version !== 1) throw new Error("Unknown custom application settings version");
          customEntries = validateEntries(saved.entries);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      })();
    await settingsLoaded;
  }
  function applyCustomEntries(target) {
    for (const [id, entry] of target) if (entry.target.kind === "custom") target.delete(id);
    for (const entry of customEntries) {
      const id = idFor("custom", entry.id);
      target.set(id, {
        id,
        title: entry.title,
        description: entry.path,
        target: { kind: "custom", path: entry.path, args: [...entry.args], cwd: entry.cwd },
      });
    }
  }

  async function discover() {
    const revision = inventoryRevision;
    const next = new Map();
    const issues = [];
    for (const root of menuRoots()) {
      const directories = [root];
      while (directories.length) {
        controller.signal.throwIfAborted();
        const directory = directories.pop();
        let children;
        try {
          children = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error.code !== "ENOENT") issues.push(`开始菜单不可读：${directory}`);
          continue;
        }
        for (const child of children) {
          if (next.size >= MAX_ENTRIES)
            throw new Error("Application inventory exceeds its entry limit");
          if (child.isSymbolicLink()) continue;
          const location = path.join(directory, child.name);
          if (child.isDirectory()) {
            directories.push(location);
            continue;
          }
          if (!child.isFile() || !/\.(?:lnk|url)$/i.test(child.name)) continue;
          if (uninstallEntry(path.basename(child.name, path.extname(child.name)))) continue;
          const id = idFor("shortcut", location.toLocaleLowerCase());
          next.set(id, {
            id,
            title: path.basename(child.name, path.extname(child.name)),
            description: path.relative(root, location),
            target: { kind: "shortcut", path: location },
            iconPath: location,
          });
        }
      }
    }
    try {
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const output = await new Promise((resolve, reject) => {
        execFile(
          powershell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(registeredScript, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
            timeout: 20_000,
            signal: controller.signal,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      const records = JSON.parse(output.replace(/^\uFEFF/, "") || "[]");
      for (const record of Array.isArray(records) ? records : [records]) {
        controller.signal.throwIfAborted();
        if (
          !record ||
          typeof record.Name !== "string" ||
          typeof record.AppID !== "string" ||
          !record.Name.trim() ||
          !record.AppID ||
          record.AppID.length > 4096 ||
          /[\x00-\x1f]/.test(record.AppID)
        )
          continue;
        if (uninstallEntry(record.Name)) continue;
        if (next.size >= MAX_ENTRIES)
          throw new Error("Application inventory exceeds its entry limit");
        const id = idFor("app", record.AppID);
        next.set(id, {
          id,
          title: record.Name,
          description: record.AppID.includes("!")
            ? "Windows 已注册应用 / AppX"
            : "Windows 已注册应用",
          target: { kind: "app", appUserModelId: record.AppID },
          iconPath:
            typeof record.Icon === "string" && path.isAbsolute(record.Icon)
              ? record.Icon
              : [...next.values()].find((entry) => entry.title === record.Name)?.iconPath,
        });
      }
    } catch (error) {
      controller.signal.throwIfAborted();
      issues.push(`Windows 注册应用读取失败：${error.message}`);
    }
    controller.signal.throwIfAborted();
    applyCustomEntries(next);
    entries = next;
    refreshedAt = revision === inventoryRevision ? Date.now() : 0;
    warnings = issues;
    sources = { shortcuts: 0, registeredApplications: 0, appx: 0 };
    for (const entry of next.values()) {
      if (entry.target.kind === "shortcut") sources.shortcuts++;
      else if (entry.target.kind === "app") {
        sources.registeredApplications++;
        if (entry.target.appUserModelId.includes("!")) sources.appx++;
      }
    }
  }
  async function inventory(signal) {
    if (stopping) throw new Error("Application search is stopping");
    signal.throwIfAborted();
    if (!refreshing && (!refreshedAt || Date.now() - refreshedAt >= CACHE_MS)) {
      refreshing = discover().finally(() => {
        refreshing = undefined;
      });
    }
    if (refreshing) {
      let onAbort;
      try {
        await Promise.race([
          refreshing,
          new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error("Application query cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
    signal.throwIfAborted();
    return entries;
  }

  return {
    async activate(activation, context) {
      context.signal.throwIfAborted();
      await loadSettings();
      const input = activation.parameters;
      if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input)))
        throw new Error("Application parameters must be an object");
      const action =
        input?.action ??
        (["launch", "reveal", "copy-path", "refresh"].includes(activation.commandId)
          ? activation.commandId
          : "search");
      if (activation.commandId === "settings") {
        if (action === "get") return { entries: structuredClone(customEntries) };
        if (action !== "save") throw new Error("Unknown custom application settings action");
        const next = validateEntries(input.entries);
        const serialized = JSON.stringify({ version: 1, entries: next }, null, 2) + "\n";
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024)
          throw new Error("Custom application settings are too large");
        const task = saving.then(async () => {
          context.signal.throwIfAborted();
          // The independent npm backend cannot import host persistence.ts.
          // Keep its fsync + same-directory rename transaction only here.
          await fs.mkdir(lifetime.dataDir, { recursive: true });
          const temporary = `${customFile}.${randomUUID()}.tmp`;
          let file;
          try {
            file = await fs.open(temporary, "wx", 0o600);
            await file.writeFile(serialized);
            await file.sync();
            await file.close();
            file = undefined;
            context.signal.throwIfAborted();
            await fs.rename(temporary, customFile);
          } finally {
            await file?.close();
            await fs.rm(temporary, { force: true });
          }
          customEntries = next;
          applyCustomEntries(entries);
          currentQuery?.abort();
          return { entries: structuredClone(customEntries) };
        });
        saving = task.catch(() => {});
        return task;
      }
      if (["launch", "reveal", "copy-path"].includes(action)) {
        // Launch only the exact item the private inventory knows. Never consume
        // renderer paths, command lines, executable arguments or shell URLs.
        if (typeof input?.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id))
          throw new Error("Choose an indexed application before launching");
        const selected = entries.get(input.id);
        if (!selected) throw new Error("Application selection expired; search again");
        if (selected.target.kind !== "app") {
          try {
            if (!(await fs.stat(selected.target.path)).isFile())
              throw new Error("Application file is unavailable");
          } catch (error) {
            entries.delete(input.id);
            invalidate();
            throw error;
          }
        }
        return {
          action:
            action === "launch"
              ? "launchApplication"
              : action === "reveal"
                ? "revealApplication"
                : "copyApplicationPath",
          target: { ...selected.target },
        };
      }
      if (action === "refresh") invalidate();
      else if (action !== "search") throw new Error("Unknown application action");
      const query =
        input?.query ?? (activation.context?.kind === "text" ? activation.context.text : "");
      if (typeof query !== "string" || query.length > 2000)
        throw new Error("Invalid application query");
      const limit = input?.limit ?? 30;
      const english = input?.locale === "en-US";
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Application result limit must be between 1 and 100");
      currentQuery?.abort();
      const queryController = new AbortController();
      currentQuery = queryController;
      const querySignal = AbortSignal.any([
        context.signal,
        queryController.signal,
        controller.signal,
      ]);
      const source = await inventory(querySignal);
      const needle = normalize(query);
      const tokens = needle.split(/\s+/).filter(Boolean);
      const results = [];
      const entriesByIndex = [...source.values()];
      const matches = /[a-z]{2}/i.test(needle)
        ? await pinyin.match(
            entriesByIndex.map((entry) => normalize(entry.title)),
            needle,
            querySignal,
          )
        : { matches: [] };
      querySignal.throwIfAborted();
      const pinyinMatches = new Map(matches.matches.map((match) => [match.index, match]));
      for (const [index, entry] of entriesByIndex.entries()) {
        const title = normalize(entry.title);
        const latinInitials =
          title
            .match(/[a-z0-9]+/g)
            ?.map((word) => word[0])
            .join("") ?? "";
        const literal =
          !needle ||
          tokens.every((token) => title.includes(token)) ||
          (/^[a-z]+$/.test(needle) && latinInitials.startsWith(needle));
        const pinyinMatch = pinyinMatches.get(index);
        if (!literal && !pinyinMatch) continue;
        const score =
          title === needle
            ? 100
            : title.startsWith(needle)
              ? 80
              : title.includes(needle)
                ? 60
                : literal
                  ? 40
                  : pinyinMatch.kind === "full"
                    ? 55
                    : 35;
        results.push({ entry, score, pinyinMatch });
      }
      results.sort(
        (left, right) =>
          right.score - left.score ||
          Number(left.entry.target.kind !== "shortcut") -
            Number(right.entry.target.kind !== "shortcut") ||
          left.entry.title.localeCompare(right.entry.title, "zh-CN"),
      );
      return {
        items: results.slice(0, limit).map(({ entry, pinyinMatch }) => ({
          id: entry.id,
          title: entry.title,
          description: `${entry.target.kind !== "app" ? entry.description : english ? (entry.target.appUserModelId.includes("!") ? "Windows registered application / AppX" : "Windows registered application") : entry.description}${pinyinMatch ? (english ? " · Pinyin match" : " · 拼音匹配") : ""}`,
          kind: "application",
          commandId: "launch",
          parameters: { action: "launch", id: entry.id },
          iconPath: entry.iconPath ?? (entry.target.kind !== "app" ? entry.target.path : undefined),
          actions: [
            {
              title: english ? "Show location" : "打开所在位置",
              commandId: "reveal",
              parameters: { action: "reveal", id: entry.id },
            },
            {
              title:
                entry.target.kind === "app"
                  ? english
                    ? "Copy application ID"
                    : "复制应用标识"
                  : english
                    ? "Copy path"
                    : "复制路径",
              commandId: "copy-path",
              parameters: { action: "copy-path", id: entry.id },
            },
          ],
        })),
        total: results.length,
        indexed: source.size,
        sources: { ...sources },
        refreshedAt,
        warnings: [...warnings],
        hint: english
          ? "Search original names, full pinyin, initials, or mixed Chinese and Latin text."
          : "支持应用原名、中文全拼、拼音首字母与中英混排。",
        pinyinSupported: true,
        ...(matches.pid
          ? {
              pinyinTask: {
                pid: matches.pid,
                exitCode: matches.exitCode,
                elapsedMs: matches.elapsedMs,
              },
            }
          : {}),
      };
    },
    prepareStop() {
      return { ok: true };
    },
    async stop() {
      stopping = true;
      clearInterval(calibration);
      for (const watcher of watchers) watcher.close();
      currentQuery?.abort();
      controller.abort();
      lifetime.signal.removeEventListener("abort", abort);
      await saving;
      await refreshing?.catch(() => {});
      await pinyin.stop();
      entries.clear();
    },
  };
}
