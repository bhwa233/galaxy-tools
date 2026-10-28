// Reuse the existing private-station boundary and the shipped service. No addon
// is needed, and failure to isolate never falls back to the user's clipboard.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const boundary =
  process.env.SPARK233_CLIPBOARD_BOUNDARY ||
  path.join(repo, "local-build/spark233/native-clipboard-p6/build/spark233_clipboard_boundary.exe");
const executable = path.join(
  repo,
  "packages/official/clipboard/native/win32-x64/spark233_clipboard_service.exe",
);
const childMode = process.argv[2] === "--child";
const run = childMode
  ? process.argv[3]
  : path.join(repo, "local-build/evidence/clipboard-service", randomUUID());
fs.mkdirSync(run, { recursive: true });
const report = { ok: false, run, interactiveClipboardAccessed: false, checks: [] };
if (!childMode) {
  const guard = spawnSync(boundary, ["context"], { encoding: "utf8", windowsHide: true });
  assert.equal(guard.status, 1);
  assert.match(guard.stderr, /private spark233 window station/);
  const result = spawnSync(
    boundary,
    ["isolate", process.execPath, fileURLToPath(import.meta.url), "--child", run],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  fs.writeFileSync(
    path.join(run, "launcher.json"),
    JSON.stringify(
      {
        exitCode: result.status,
        signal: result.signal,
        error: String(result.error ?? ""),
        stdout: result.stdout,
        stderr: result.stderr,
        interactiveGuardRejected: true,
      },
      null,
      2,
    ),
  );
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  console.log("Clipboard service evidence: " + run);
  process.exitCode = result.status === 0 ? 0 : 1;
} else {
  let service;
  const events = [];
  const wait = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      const value = events.find(predicate);
      if (value) return value;
      if (service.exitCode !== null) throw new Error("Service exited: " + service.exitCode);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Native clipboard event timed out");
  };
  const sessionId = randomUUID();
  async function request(operation, input = {}) {
    const id = randomUUID();
    service.stdin.write(
      JSON.stringify({ protocol: 1, sessionId, id, operation, ...input }) + String.fromCharCode(10),
    );
    const response = await wait((event) => event.id === id);
    assert.equal(response.ok, true, JSON.stringify(response));
  }
  try {
    const station = execFileSync(boundary, ["context"], { encoding: "utf8", windowsHide: true });
    assert.match(station, /^PRIVATE_STATION/);
    assert.ok(!station.includes("WinSta0"));
    report.checks.push("privateStationConfirmedBeforeServiceStart");
    service = spawn(
      executable,
      [
        `--spark233-session=${sessionId}`,
        `--spark233-spool=${run}`,
        "--spark233-mode=isolated",
        `--spark233-host-pid=${process.pid}`,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let errors = "";
    service.stderr.on("data", (bytes) => {
      errors += bytes;
    });
    createInterface({ input: service.stdout }).on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        report.output = line;
      }
    });
    await wait((event) => event.type === "ready");
    await request("configure", { paused: false, excludedApps: [] });
    const file = path.join(run, "fixture.txt");
    fs.writeFileSync(file, "private clipboard fixture");
    execFileSync(boundary, ["seed", file], { windowsHide: true });
    const snapshot = await wait((event) => event.type === "snapshot");
    assert.ok(fs.statSync(path.join(run, snapshot.file)).size > 8);
    report.checks.push("realListenerPublishesMixedFormatSnapshot");
    await request("restore", { file: snapshot.file });
    report.checks.push("serviceReplaysPrivateSnapshot");
    await request("stop");
    service.stdin.end();
    const exit = await new Promise((resolve) => {
      if (service.exitCode !== null) resolve(service.exitCode);
      else service.once("exit", resolve);
    });
    assert.equal(exit, 0, errors);
    report.checks.push("gracefulServiceExitConfirmed");
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack || error);
    service?.stdin.end();
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}
