// Actual UAC + LocalSystem acceptance, separate from the bounded test-host probe.
// Existing services require --use-existing (read only) or --upgrade-existing.
// Only a service installed on a previously clean machine by this run
// is removed, through the product's normal elevation helper.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../..");
const run = path.join(root, "local-build/evidence/search-system-service", randomUUID());
fs.mkdirSync(run, { recursive: true });
app.setPath("userData", path.join(run, "profile"));
const report = { ok: false, run, checks: [], serviceWasPresent: false, uacExecuted: false };
let scope,
  runtime,
  helper,
  created = false;
const load = (name) =>
  import(pathToFileURL(path.join(root, "apps/desktop/dist-electron/electron", name + ".js")));
function service() {
  const text = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Service | Where-Object Name -eq spark233Index | Select-Object Name,State,StartName,PathName,ProcessId | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  return text ? JSON.parse(text) : undefined;
}
function manage(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [action], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}
app
  .whenReady()
  .then(async () => {
    const before = service();
    report.serviceWasPresent = !!before;
    report.upgradeRequested = process.argv.includes("--upgrade-existing");
    if (
      before &&
      !process.argv.includes("--use-existing") &&
      !process.argv.includes("--upgrade-existing")
    )
      throw new Error(
        "Existing search service preserved; use a clean Windows test account/machine",
      );
    const { validatePluginDirectory, defaultHostEnvironment, resolvePluginEntries } =
      await load("plugins/manifest");
    const { PluginResourceScope } = await load("plugins/resources");
    const { createSearchRuntime } = await load("plugins/official/search");
    const pluginRoot = path.join(root, "packages/official/search");
    const metadata = validatePluginDirectory(pluginRoot, defaultHostEnvironment("1.2.0"));
    const descriptor = resolvePluginEntries(pluginRoot, metadata).native.search;
    helper = descriptor.path;
    let installed = before;
    if (!before || process.argv.includes("--upgrade-existing")) {
      report.install = await manage("--install-service");
      report.uacExecuted = true;
      installed = service();
      created = !before && !!installed;
      if (report.install.code !== 0)
        throw new Error(
          "Search service installation was not authorized or failed: " +
            JSON.stringify(report.install),
        );
    }
    assert.ok(
      installed && installed.StartName === "LocalSystem" && installed.State === "Running",
      "Real service must be running as LocalSystem",
    );
    report.service = installed;
    report.checks.push(
      before
        ? report.upgradeRequested
          ? "uacUpgradedRunningLocalSystemService"
          : "existingLocalSystemServiceRunning"
        : "uacInstalledRunningLocalSystemService",
    );
    const files = path.join(run, "files");
    fs.mkdirSync(files);
    const marker = "spark233-system-acceptance-" + randomUUID();
    fs.writeFileSync(path.join(files, "fixture.txt"), marker);
    scope = new PluginResourceScope({
      pluginId: metadata.spark233.id,
      version: metadata.version,
      instanceId: randomUUID(),
    });
    runtime = await createSearchRuntime({
      scope,
      pluginRoot,
      descriptor,
      dataDir: path.join(run, "data"),
      cacheDir: path.join(run, "cache"),
      approveTrust: () => true,
      confirmServiceAction: async () => false,
      openPath: async () => {
        throw new Error("Acceptance must not launch a document");
      },
    });
    const status = await runtime.activate({
      commandId: "service",
      parameters: { action: "status" },
    });
    report.status = status;
    assert.equal(status.status, "ok");
    report.checks.push("productionAdapterConnectsToInstalledService");
    const results = await runtime.activate({
      commandId: "content",
      parameters: { query: marker, directory: files },
    });
    assert.ok(
      results.items.some((item) => item.title === "fixture.txt"),
      "Controlled file must be found through production service",
    );
    report.checks.push("realServiceFindsControlledFile");
    report.ok = true;
  })
  .catch((error) => {
    report.error = String(error.stack || error);
  })
  .finally(async () => {
    if (scope) {
      const decision = await scope.prepareStop("shutdown");
      if (decision.ok) {
        const released = await scope.release();
        if (!released.ok) {
          report.ok = false;
          report.cleanupError = released.errors;
        }
      } else {
        report.ok = false;
        report.cleanupError = decision;
      }
    }
    if (created) {
      report.uninstall = await manage("--uninstall-service");
      report.serviceRetained = !!service();
      if (report.uninstall.code !== 0 || report.serviceRetained) report.ok = false;
      else report.checks.push("testInstalledServiceRemovedWithProductHelper");
    }
    fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
