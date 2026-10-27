/* eslint-disable no-control-regex -- Reject control characters in Windows application identities. */
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createPinyinMatcher } from "./pinyin.mjs";
import {
  SUPPORTED_KINDS,
  validateEntries,
  readSettingsFile,
  writeSettingsFile,
  assertEntryTarget,
} from "./custom-entries.mjs";

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
  let lastAttemptAt = 0;
  let inventoryState = "partial";
  let sourceStatus = { menus: [], registeredApplications: { state: "partial" } };
  let snapshots = new Map();
  const rejectedTargets = new Set();
  const roots = menuRoots();
  let inventoryRevision = 0;
  let refreshing;
  let warnings = [];
  let sources = { shortcuts: 0, registeredApplications: 0, appx: 0 };
  let stopping = false;
  const queries = new Map();
  const customFile = path.join(lifetime.dataDir, "custom-entries.json");
  let customEntries = [];
  let settingsLoaded;
  let saving = Promise.resolve();
  const acceptedSaves = new Set();
  const watchers = [];
  const invalidate = () => {
    inventoryRevision++;
    lastAttemptAt = 0;
  };
  for (const directory of roots) {
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

  async function loadSettings() {
    if (!settingsLoaded)
      settingsLoaded = (async () => {
        customEntries = (await readSettingsFile(customFile))?.entries ?? [];
      })();
    await settingsLoaded;
  }
  function applyCustomEntries(target) {
    for (const [id, entry] of target) if (entry.customKind) target.delete(id);
    for (const entry of customEntries) {
      const id = idFor("custom", entry.id);
      if (rejectedTargets.has(id)) continue;
      target.set(id, {
        id,
        title: entry.title,
        description: entry.path,
        customKind: entry.kind,
        target:
          entry.kind === "document" || entry.kind === "directory"
            ? { kind: entry.kind, path: entry.path }
            : { kind: "custom", path: entry.path, args: [...entry.args], cwd: entry.cwd },
      });
    }
  }

  function selectionVersion(entry) {
    const target = entry.target;
    return createHash("sha256")
      .update(
        JSON.stringify([
          entry.customKind ?? target.kind,
          target.path ?? "",
          target.args ?? [],
          target.cwd ?? "",
          target.appUserModelId ?? "",
        ]),
      )
      .digest("hex");
  }

  async function discover() {
    const revision = inventoryRevision;
    const pending = new Map(snapshots);
    const issues = [];
    const menuStates = [];
    const authoritativeIds = new Set();
    // Snapshots belong to a source, never to the merged result. A failed scan
    // cannot confirm deletions; custom entries are applied from current settings
    // only after discovery, so removed custom IDs cannot return through fallback.
    const accept = (key, found, complete) => {
      const previous = snapshots.get(key);
      const snapshot = complete
        ? { entries: found, hasCompleteSnapshot: true, lastCompleteAt: Date.now() }
        : previous?.hasCompleteSnapshot
          ? previous
          : { entries: found, hasCompleteSnapshot: false, lastCompleteAt: 0 };
      pending.set(key, snapshot);
      if (complete) {
        for (const id of previous?.entries.keys() ?? []) authoritativeIds.add(id);
        for (const id of found.keys()) authoritativeIds.add(id);
      }
      return {
        state: complete ? "complete" : snapshot.hasCompleteSnapshot ? "stale" : "partial",
        hasCompleteSnapshot: snapshot.hasCompleteSnapshot,
        lastCompleteAt: snapshot.lastCompleteAt,
        count: snapshot.entries.size,
      };
    };
    for (const root of roots) {
      const found = new Map();
      const directories = [root];
      let complete = true;
      while (directories.length) {
        controller.signal.throwIfAborted();
        const directory = directories.pop();
        let children;
        try {
          children = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          // Missing roots or enumerated children cannot confirm deletions. Only
          // a successful read, including an empty directory, is authoritative.
          complete = false;
          issues.push(`开始菜单不可读：${directory}`);
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const location = path.join(directory, child.name);
          if (child.isDirectory()) {
            directories.push(location);
            continue;
          }
          if (!child.isFile() || !/\.(?:lnk|url)$/i.test(child.name)) continue;
          if (uninstallEntry(path.basename(child.name, path.extname(child.name)))) continue;
          if (found.size >= MAX_ENTRIES) {
            complete = false;
            issues.push(`开始菜单条目超过上限：${root}`);
            directories.length = 0;
            break;
          }
          const id = idFor("shortcut", location.toLocaleLowerCase());
          found.set(id, {
            id,
            title: path.basename(child.name, path.extname(child.name)),
            description: path.relative(root, location),
            target: { kind: "shortcut", path: location },
            iconPath: location,
          });
        }
      }
      menuStates.push({ root, ...accept(`menu:${root}`, found, complete) });
    }
    const shortcuts = menuStates.flatMap(({ root }) => [
      ...pending.get(`menu:${root}`).entries.values(),
    ]);
    const registered = new Map();
    let registeredComplete = true;
    try {
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const output = await new Promise((resolve, reject) => {
        let completed;
        const child = execFile(
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
          (error, stdout) => {
            completed = { error, stdout };
          },
        );
        // Abort/timeout callbacks may run before stdio and the process close.
        // Stop must wait for the owned system query to actually finish.
        child.once("close", () => {
          if (!completed)
            reject(new Error("Registered application process closed without a result"));
          else if (completed.error) reject(completed.error);
          else resolve(completed.stdout);
        });
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
        ) {
          registeredComplete = false;
          issues.push("Windows 注册应用返回不完整条目");
          continue;
        }
        if (uninstallEntry(record.Name)) continue;
        if (registered.size >= MAX_ENTRIES)
          throw new Error("Application inventory exceeds its entry limit");
        const id = idFor("app", record.AppID);
        registered.set(id, {
          id,
          title: record.Name,
          description: record.AppID.includes("!")
            ? "Windows 已注册应用 / AppX"
            : "Windows 已注册应用",
          target: { kind: "app", appUserModelId: record.AppID },
          iconPath:
            typeof record.Icon === "string" && path.isAbsolute(record.Icon)
              ? record.Icon
              : shortcuts.find((entry) => entry.title === record.Name)?.iconPath,
        });
      }
    } catch (error) {
      controller.signal.throwIfAborted();
      registeredComplete = false;
      issues.push(`Windows 注册应用读取失败：${error.message}`);
    }
    const registeredState = accept("registered", registered, registeredComplete);
    controller.signal.throwIfAborted();
    const next = new Map();
    const canRestoreRejected = revision === inventoryRevision;
    for (const snapshot of pending.values())
      for (const [id, entry] of snapshot.entries)
        if (!rejectedTargets.has(id) || (canRestoreRejected && authoritativeIds.has(id)))
          next.set(id, entry);
    // A rejected custom ID is restored only after a real metadata check of
    // the still-configured target, never from a retained discovery snapshot.
    for (const entry of customEntries) {
      const id = idFor("custom", entry.id);
      if (!rejectedTargets.has(id)) continue;
      try {
        await assertEntryTarget(entry, controller.signal);
        if (revision === inventoryRevision && customEntries.includes(entry))
          rejectedTargets.delete(id);
      } catch {
        controller.signal.throwIfAborted();
      }
    }
    applyCustomEntries(next);
    for (const id of rejectedTargets)
      if (!canRestoreRejected || !authoritativeIds.has(id)) next.delete(id);
    if (next.size > MAX_ENTRIES) throw new Error("Application inventory exceeds its entry limit");
    controller.signal.throwIfAborted();
    const states = [...menuStates, registeredState];
    const complete = states.every((source) => source.state === "complete");
    entries = next;
    snapshots = pending;
    if (canRestoreRejected) for (const id of authoritativeIds) rejectedTargets.delete(id);
    lastAttemptAt = revision === inventoryRevision ? Date.now() : 0;
    if (complete) refreshedAt = Date.now();
    inventoryState = complete
      ? "complete"
      : states.some((source) => source.state === "partial")
        ? "partial"
        : "stale";
    sourceStatus = { menus: menuStates, registeredApplications: registeredState };
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
    if (!refreshing && (!lastAttemptAt || Date.now() - lastAttemptAt >= CACHE_MS)) {
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

  async function activate(activation, context) {
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
      if (action === "get")
        return { entries: structuredClone(customEntries), supportedKinds: [...SUPPORTED_KINDS] };
      if (action !== "save") throw new Error("Unknown custom application settings action");
      const next = validateEntries(input.entries);
      const task = saving.then(async () => {
        context.signal.throwIfAborted();
        await writeSettingsFile(customFile, next, context.signal);
        for (const entry of next) {
          const previous = customEntries.find((saved) => saved.id === entry.id);
          if (
            !previous ||
            previous.kind !== entry.kind ||
            previous.path !== entry.path ||
            previous.cwd !== entry.cwd ||
            JSON.stringify(previous.args) !== JSON.stringify(entry.args)
          )
            rejectedTargets.delete(idFor("custom", entry.id));
        }
        customEntries = next;
        invalidate();
        applyCustomEntries(entries);
        for (const request of queries.values()) request.controller.abort();
        queries.clear();
        return { entries: structuredClone(customEntries), supportedKinds: [...SUPPORTED_KINDS] };
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
      if (
        typeof input.selectionVersion !== "string" ||
        input.selectionVersion !== selectionVersion(selected)
      )
        throw new Error("Application selection changed; search again");
      if (selected.target.kind !== "app") {
        try {
          if (selected.customKind) {
            await assertEntryTarget(
              { ...selected.target, kind: selected.customKind },
              context.signal,
            );
          } else if (!(await fs.stat(selected.target.path)).isFile()) {
            throw new Error("Application file is unavailable");
          }
          context.signal.throwIfAborted();
          if (entries.get(input.id) !== selected) throw new Error("Application selection changed");
        } catch (error) {
          context.signal.throwIfAborted();
          if (entries.get(input.id) !== selected) throw error;
          entries.delete(input.id);
          // A retained source must not resurrect a target already rejected
          // by live validation. A later complete scan can rediscover it.
          rejectedTargets.add(input.id);
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
    if (
      input?.includeIds !== undefined &&
      (!Array.isArray(input.includeIds) ||
        input.includeIds.length > 100 ||
        input.includeIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/i.test(id)))
    )
      throw new Error("Application includeIds must contain at most 100 unique stable IDs");
    const includeIds = input?.includeIds?.map((id) => id.toLowerCase()) ?? [];
    if (new Set(includeIds).size !== includeIds.length)
      throw new Error("Application includeIds must contain unique stable IDs");
    if (
      input?.onlyIds !== undefined &&
      (typeof input.onlyIds !== "boolean" || input.includeIds === undefined)
    )
      throw new Error("Application onlyIds requires a boolean and valid includeIds");
    const onlyIds = input?.onlyIds === true;
    for (const key of ["callerId", "requestId"])
      if (
        input?.[key] !== undefined &&
        (typeof input[key] !== "string" ||
          !input[key] ||
          input[key].length > 200 ||
          /[\x00-\x1f]/.test(input[key]))
      )
        throw new Error(`Invalid application query ${key}`);
    const callerId = input?.callerId ?? "legacy";
    const request = {
      requestId: input?.requestId ?? randomUUID(),
      controller: new AbortController(),
    };
    queries.get(callerId)?.controller.abort();
    queries.set(callerId, request);
    const querySignal = AbortSignal.any([
      context.signal,
      request.controller.signal,
      controller.signal,
    ]);
    try {
      const source = await inventory(querySignal);
      // Another caller may refresh discovery while this caller awaits pinyin.
      // Keep its source status bound to the inventory it actually searched.
      const status = {
        sources: { ...sources },
        refreshedAt,
        lastAttemptAt,
        inventoryState,
        sourceStatus: {
          ...structuredClone(sourceStatus),
          custom: { state: "complete", count: customEntries.length },
        },
        warnings: [...warnings],
      };
      const needle = normalize(query);
      const tokens = needle.split(/\s+/).filter(Boolean);
      const results = [];
      const entriesByIndex = onlyIds ? [] : [...source.values()];
      const matches =
        !onlyIds && /[a-z]{2}/i.test(needle)
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
      // Stored preferences resolve exact current inventory identities. This
      // adds query results only; launch still revalidates the private index.
      const included = new Map();
      for (const id of includeIds) {
        const entry = source.get(id);
        if (entry && entries.has(id) && !rejectedTargets.has(id)) included.set(id, { entry });
      }
      for (const result of results)
        if (included.has(result.entry.id)) included.set(result.entry.id, result);
      // Preference IDs must not exhaust the page before natural exact titles.
      // Pure ID resolution preserves the caller's explicit order unchanged.
      const exact = onlyIds ? [] : results.filter(({ score }) => score === 100);
      const exactIds = new Set(exact.map(({ entry }) => entry.id));
      const merged = [
        ...exact,
        ...[...included.values()].filter(({ entry }) => !exactIds.has(entry.id)),
        ...results.filter(({ entry }) => !exactIds.has(entry.id) && !included.has(entry.id)),
      ];
      const admitted = [];
      let unavailableCustom = 0;
      for (const result of merged) {
        querySignal.throwIfAborted();
        const { entry } = result;
        if (entry.customKind) {
          try {
            await assertEntryTarget({ ...entry.target, kind: entry.customKind }, querySignal);
            if (entries.get(entry.id) !== entry) continue;
          } catch {
            querySignal.throwIfAborted();
            if (entries.get(entry.id) === entry) {
              entries.delete(entry.id);
              rejectedTargets.add(entry.id);
              invalidate();
            }
            unavailableCustom++;
            continue;
          }
        }
        admitted.push(result);
        if (admitted.length === limit) break;
      }
      querySignal.throwIfAborted();
      return {
        items: admitted.map(({ entry, pinyinMatch }) => ({
          id: entry.id,
          title: entry.title,
          description: `${entry.target.kind !== "app" ? entry.description : english ? (entry.target.appUserModelId.includes("!") ? "Windows registered application / AppX" : "Windows registered application") : entry.description}${pinyinMatch ? (english ? " · Pinyin match" : " · 拼音匹配") : ""}`,
          kind: ["document", "directory"].includes(entry.customKind)
            ? entry.customKind
            : "application",
          commandId: "launch",
          parameters: { action: "launch", id: entry.id, selectionVersion: selectionVersion(entry) },
          iconPath: entry.iconPath ?? (entry.target.kind !== "app" ? entry.target.path : undefined),
          actions: [
            {
              title: english ? "Show location" : "打开所在位置",
              commandId: "reveal",
              parameters: {
                action: "reveal",
                id: entry.id,
                selectionVersion: selectionVersion(entry),
              },
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
              parameters: {
                action: "copy-path",
                id: entry.id,
                selectionVersion: selectionVersion(entry),
              },
            },
          ],
        })),
        total: merged.length - unavailableCustom,
        indexed: source.size,
        ...status,
        hint:
          (unavailableCustom
            ? english
              ? "Some custom targets are missing or changed type. "
              : "部分自定义目标不存在或类型已改变。 "
            : "") +
          (status.warnings.length
            ? english
              ? "Some application sources are unavailable; results may be incomplete or stale. "
              : "应用来源读取异常，结果可能不完整或过期。 "
            : "") +
          (english
            ? "Search original names, full pinyin, initials, or mixed Chinese and Latin text."
            : "支持应用原名、中文全拼、拼音首字母与中英混排。"),
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
    } finally {
      // An older request may settle after its replacement has registered.
      // Only the request still owning this caller slot may remove it.
      if (queries.get(callerId) === request) queries.delete(callerId);
    }
  }
  return {
    activate(activation, context) {
      const operation = activate(activation, context);
      if (activation.commandId === "settings" && activation.parameters?.action === "save") {
        // Register before loadSettings yields, so a following stop also drains
        // a Save accepted while the first configuration read is still pending.
        acceptedSaves.add(operation);
        void operation.finally(() => acceptedSaves.delete(operation)).catch(() => {});
      }
      return operation;
    },
    async prepareStop() {
      while (acceptedSaves.size) await Promise.allSettled(acceptedSaves);
      await saving;
      return { ok: true };
    },
    async stop() {
      stopping = true;
      clearInterval(calibration);
      for (const watcher of watchers) watcher.close();
      for (const request of queries.values()) request.controller.abort();
      queries.clear();
      controller.abort();
      lifetime.signal.removeEventListener("abort", abort);
      while (acceptedSaves.size) await Promise.allSettled(acceptedSaves);
      await saving;
      await refreshing?.catch(() => {});
      await pinyin.stop();
      entries.clear();
      snapshots.clear();
      rejectedTargets.clear();
    },
  };
}
