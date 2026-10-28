// Real utility backends and OCR engine with generated data. The existing notes,
// search, capture and application-icon probes cover their own OS boundaries.
// This runner never reads the interactive clipboard or external provider keys.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const tar = require("tar");
const root = path.resolve(__dirname, "..");
const run = path.join(root, "local-build/evidence/plugin-business", randomUUID());
fs.mkdirSync(run, { recursive: true });
app.setPath("userData", path.join(run, "profile"));
const report = {
  ok: false,
  run,
  checks: [],
  externalAiExecuted: false,
  interactiveClipboardAccessed: false,
};
const scopes = [];
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
};
const load = (name) =>
  import(pathToFileURL(path.join(root, "apps/desktop/dist-electron/electron", name + ".js")));
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const { PluginResourceScope } = await load("plugins/resources");
    const { createTrustedBackend } = await load("plugins/backend");
    const { resolvePluginEntries, validatePluginDirectory, defaultHostEnvironment } =
      await load("plugins/manifest");
    const { textClipboardSnapshot } = await load("plugins/official/clipboard-history");
    const { createOcrRuntime } = await load("plugins/official/capture");
    const { performIndexedApplicationAction } = await load("plugins/official/applications");
    async function packagedRoot(name) {
      const bundled =
        process.env.SPARK233_ACCEPTANCE_PACKAGE_DIR || path.join(root, "dist-plugins");
      const index = JSON.parse(fs.readFileSync(path.join(bundled, "index.json")));
      const item = index.plugins.find((entry) => entry.pluginId === "spark233." + name);
      assert.ok(item, "Bundled plugin missing: " + name);
      assert.equal(
        "sha512-" +
          createHash("sha512")
            .update(fs.readFileSync(path.join(bundled, item.file)))
            .digest("base64"),
        item.integrity,
        "Bundled archive integrity",
      );
      const destination = path.join(run, "packages", name);
      fs.mkdirSync(destination, { recursive: true });
      await tar.x({ file: path.join(bundled, item.file), cwd: destination, strict: true });
      (report.packages ??= {})[name] = { version: item.version, integrity: item.integrity };
      return path.join(destination, "package");
    }
    async function backend(name) {
      const pluginRoot = await packagedRoot(name);
      const manifest = validatePluginDirectory(pluginRoot, defaultHostEnvironment("1.2.0"));
      const scope = new PluginResourceScope({
        pluginId: manifest.spark233.id,
        version: manifest.version,
        instanceId: randomUUID(),
      });
      scopes.push(scope);
      const worker = await createTrustedBackend({
        scope,
        pluginRoot,
        entryPath: resolvePluginEntries(pluginRoot, manifest).backend.entry,
        dataDir: path.join(run, name, "data"),
        cacheDir: path.join(run, name, "cache"),
        approveTrust: () => true,
        timeoutMs: 30000,
      });
      return {
        scope,
        worker,
        call: (parameters, commandId = "data") => worker.activate({ commandId, parameters }),
      };
    }
    const translation = await backend("translation");
    const search = await translation.call({ action: "search", query: "hello" }, "lookup");
    check(
      "offlineDictionaryFindsRealEntry",
      search.kind === "dictionary-search" && search.items.length > 0,
    );
    const detail = await translation.call({ action: "detail", id: search.items[0].id }, "lookup");
    check(
      "offlineDictionaryDetailUsesOpaqueSelection",
      detail.kind === "dictionary-entry" && !!detail.entry.word,
    );
    const configuration = await translation.call({ action: "config_status" }, "translate");
    check(
      "freshProfileHasNoExternalProviderSecret",
      !configuration.configured && !configuration.hasKey,
    );
    await assert.rejects(
      translation.call(
        { action: "translate", text: "isolated fixture", requestId: randomUUID() },
        "translate",
      ),
      /config|配置|服务/i,
    );
    report.checks.push("unconfiguredTranslationRefusesNetworkWork");
    const prefs = await translation.call(
      { action: "preferences_set", autoLookup: false, historyEnabled: true },
      "translate",
    );
    check("translationPreferencesPersist", !prefs.autoLookup && prefs.historyEnabled);

    const clipboard = await backend("clipboard");
    const snapshot = path.join(run, "clipboard/cache/fixture.scb");
    fs.writeFileSync(snapshot, textClipboardSnapshot("spark233 验收文本"));
    await clipboard.call({
      action: "native.capture",
      file: snapshot,
      source: { executable: "fixture.exe", title: "Isolated fixture" },
    });
    const page = await clipboard.call({ action: "list", query: "验收文本" });
    check("clipboardBackendCapturesAndSearchesControlledSnapshot", page.entries.length === 1);
    const id = page.entries[0].id;
    await clipboard.call({
      action: "draft.save",
      id,
      text: "durable draft",
      note: "备注",
      tags: "one,two",
    });
    const entry = await clipboard.call({ action: "detail", id });
    check("clipboardDraftSurvivesSeparateRequest", entry.draft?.text === "durable draft");
    await clipboard.call({ action: "favorite", id, enabled: true });
    const favorites = await clipboard.call({ action: "list", view: "favorites" });
    check(
      "clipboardFavoriteRetainsEntry",
      favorites.entries.some((item) => item.id === id),
    );

    const applications = await backend("applications");
    const marker = path.join(run, "application-launched.txt");
    const node = process.env.SPARK233_ACCEPTANCE_NODE;
    assert.ok(
      node && fs.existsSync(node),
      "SPARK233_ACCEPTANCE_NODE must name the selected Windows node.exe",
    );
    const title = "Spark233 acceptance " + randomUUID();
    await applications.call(
      {
        action: "save",
        entries: [
          {
            id: randomUUID(),
            title,
            path: node,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`],
            cwd: run,
            kind: "program",
          },
        ],
      },
      "settings",
    );
    const apps = await applications.call({ action: "search", query: title }, "search");
    const hit = apps.items.find((item) => item.title === title);
    check("applicationSearchResolvesRealControlledExecutable", !!hit);
    const launch = await applications.call(hit.parameters, hit.commandId);
    await performIndexedApplicationAction(launch);
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      "applicationLaunchExecutesSelectedTargetAndArguments",
      fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === "executed",
    );

    const canvas = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    let png;
    try {
      await canvas.loadURL(
        "data:text/html,<canvas id='fixture' width='900' height='240'></canvas>",
      );
      png = await canvas.webContents.executeJavaScript(
        `(() => { const c=document.getElementById('fixture'); const x=c.getContext('2d'); x.fillStyle='white'; x.fillRect(0,0,900,240); x.fillStyle='black'; x.font='bold 64px Arial'; x.fillText('SPARK233 HELLO WORLD',30,130); return c.toDataURL('image/png').split(',')[1]; })()`,
      );
    } finally {
      canvas.destroy();
    }
    const image = path.join(run, "ocr-fixture.png");
    fs.writeFileSync(image, Buffer.from(png, "base64"));
    const pluginRoot = await packagedRoot("ocr");
    const manifest = validatePluginDirectory(pluginRoot, defaultHostEnvironment("1.2.0"));
    const scope = new PluginResourceScope({
      pluginId: manifest.spark233.id,
      version: manifest.version,
      instanceId: randomUUID(),
    });
    scopes.push(scope);
    let output;
    const ocr = await createOcrRuntime({
      scope,
      pluginRoot,
      descriptor: resolvePluginEntries(pluginRoot, manifest).native.ocr,
      dataDir: path.join(run, "ocr/data"),
      cacheDir: path.join(run, "ocr/cache"),
      approveTrust: () => true,
      resolveImage: () => image,
      onResult: (result) => {
        output = result;
      },
      timeoutMs: 60000,
    });
    await ocr.activate({
      commandId: "ocr",
      context: {
        kind: "image",
        resource: { id: "controlled-ocr-fixture", kind: "image", mimeType: "image/png" },
      },
    });
    check(
      "nativeOfflineOcrRecognizesGeneratedImage",
      /HELLO/i.test(output?.text) && /WORLD/i.test(output?.text),
    );
    report.ocr = { text: output.text, lines: output.lines.length };
    report.ok = true;
  })
  .catch((error) => {
    report.error = String(error.stack || error);
  })
  .finally(async () => {
    for (const scope of scopes.reverse()) {
      try {
        const decision = await scope.prepareStop("shutdown");
        if (!decision.ok) throw new Error(decision.reason || "Save preparation refused");
        const released = await scope.release();
        if (!released.ok) throw new Error(released.errors.join("; "));
      } catch (error) {
        report.ok = false;
        (report.cleanupErrors ??= []).push(String(error));
      }
    }
    fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  });
