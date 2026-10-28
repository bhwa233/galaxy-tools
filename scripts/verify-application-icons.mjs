// Windows regression probe: real shortcuts, Electron and the production result
// decorator. All fixtures/profile data stay under local-build; nothing launches.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const repo = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "win32") throw new Error("Application icon probe requires Windows");
if (!process.versions.electron) {
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [fileURLToPath(import.meta.url)], {
    cwd: repo,
    stdio: "inherit",
    env,
  });
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  void (async () => {
    const { app, shell, nativeImage } = await import("electron");
    const parent = path.join(repo, "local-build/spark233/application-icons-probe");
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, "run-"));
    app.setPath("userData", root);
    const watchdog = setTimeout(() => app.exit(1), 60_000);
    const report = { ok: false, root, checks: [] };
    try {
      await app.whenReady();
      const { decorateApplicationResults, clearApplicationIconCache } =
        await import("../apps/desktop/dist-electron/electron/plugins/official/applications.js");
      const target = path.join(process.env.SystemRoot, "System32/cmd.exe");
      const resource = path.join(process.env.SystemRoot, "System32/shell32.dll");
      // A solid green icon gives an independent pixel oracle for explicit icons.
      const pixels = Buffer.alloc(32 * 32 * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i + 1] = 255;
        pixels[i + 3] = 255;
      }
      const png = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }).toPNG();
      const header = Buffer.alloc(22);
      header.writeUInt16LE(1, 2);
      header.writeUInt16LE(1, 4);
      header[6] = header[7] = 32;
      header.writeUInt16LE(1, 10);
      header.writeUInt16LE(32, 12);
      header.writeUInt32LE(png.length, 14);
      header.writeUInt32LE(22, 18);
      const customIcon = path.join(root, "green.ico");
      fs.writeFileSync(customIcon, Buffer.concat([header, png]));
      const definitions = [
        { name: "default" },
        { name: "自定义 图标", icon: customIcon, iconIndex: 0 },
        { name: "resource-zero", icon: resource, iconIndex: 0 },
        { name: "resource-three", icon: resource, iconIndex: 3 },
      ];
      const items = definitions.map(({ name, ...icon }, index) => {
        const file = path.join(root, `${name}.lnk`);
        assert.ok(
          shell.writeShortcutLink(file, { target, cwd: root, args: "/k echo fixture", ...icon }),
        );
        return { id: String(index), title: name, iconPath: file };
      });
      const page = { items };
      const result = await decorateApplicationResults(page);
      for (const item of result.items) {
        assert.match(item.icon ?? "", /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/);
        assert.ok(item.icon.length <= 32768);
        assert.equal("iconPath" in item, false);
        fs.writeFileSync(
          path.join(root, `${item.id}.png`),
          nativeImage.createFromDataURL(item.icon).toPNG(),
        );
      }
      const generic = (await app.getFileIcon(items[0].iconPath, { size: "small" })).toDataURL();
      assert.notEqual(
        result.items[0].icon,
        generic,
        "shortcut must show its application's icon, not the generic .lnk icon",
      );
      const targetIcon = (await app.getFileIcon(target, { size: "small" })).toDataURL();
      assert.equal(result.items[0].icon, targetIcon);
      report.checks.push("default shortcut resolves application icon");
      const bitmap = nativeImage.createFromDataURL(result.items[1].icon).toBitmap();
      const middle = (16 * 32 + 16) * 4;
      assert.ok(
        bitmap[middle] <= 2 &&
          bitmap[middle + 1] >= 250 &&
          bitmap[middle + 2] <= 2 &&
          bitmap[middle + 3] >= 250,
        "explicit icon must retain its green pixels",
      );
      report.checks.push("explicit ICO and Unicode/space path preserved");
      assert.equal(result.items[3].icon, targetIcon);
      report.checks.push("unsupported DLL resource index falls back to the target icon");
      assert.deepEqual(await decorateApplicationResults(page), result);
      clearApplicationIconCache();
      const reread = await decorateApplicationResults(page);
      assert.notEqual(reread.items[0].icon, generic);
      assert.equal(reread.items[1].icon, result.items[1].icon);
      assert.equal(reread.items[3].icon, targetIcon);
      report.checks.push("warm cache and cache reset preserve icon selection");
      clearApplicationIconCache();
      const pending = decorateApplicationResults({ items: [items[0]] });
      clearApplicationIconCache();
      const stale = await pending;
      assert.ok(
        stale.items.every((item) => !("icon" in item)),
        "clearing during a read must suppress the old generation",
      );
      report.checks.push("in-flight reads cannot republish cleared icons");
      assert.ok(
        shell.writeShortcutLink(items[0].iconPath, "update", { icon: customIcon, iconIndex: 0 }),
      );
      const changed = new Date(Date.now() + 2000);
      fs.utimesSync(items[0].iconPath, changed, changed);
      const updated = await decorateApplicationResults({ items: [items[0]] });
      assert.equal(updated.items[0].icon, result.items[1].icon);
      report.checks.push("changed shortcut invalidates its cached icon");
      await decorateApplicationResults({ items: [items[1]] });
      fs.writeFileSync(customIcon, "invalid icon data");
      fs.utimesSync(customIcon, changed, changed);
      const fallback = await decorateApplicationResults({ items: [items[1]] });
      assert.equal(fallback.items[0].icon, targetIcon);
      report.checks.push(
        "changed or invalid icon source invalidates cache and falls back to target",
      );
      const missing = await decorateApplicationResults({
        items: [{ id: "missing", iconPath: path.join(root, "missing.lnk") }],
      });
      assert.deepEqual(missing.items, [{ id: "missing" }]);
      report.checks.push("missing shortcut degrades without exposing a file path");
      const liveLinks = [
        path.join(
          process.env.APPDATA,
          "Microsoft/Windows/Start Menu/Programs/Visual Studio Code.lnk",
        ),
        path.join(
          process.env.ProgramData,
          "Microsoft/Windows/Start Menu/Programs/Visual Studio 2022/Visual Studio Tools/Developer Command Prompt for VS 2022.lnk",
        ),
      ].filter((file) => fs.existsSync(file));
      for (const [index, file] of liveLinks.entries()) {
        const live = await decorateApplicationResults({
          items: [{ id: String(index), iconPath: file }],
        });
        assert.match(live.items[0].icon ?? "", /^data:image\/png;base64,/);
        const old = (await app.getFileIcon(file, { size: "small" })).toDataURL();
        assert.notEqual(live.items[0].icon, old);
        fs.writeFileSync(
          path.join(root, `live-${index}.png`),
          nativeImage.createFromDataURL(live.items[0].icon).toPNG(),
        );
      }
      if (liveLinks.length) report.checks.push(`real installed shortcuts: ${liveLinks.length}`);
      report.ok = true;
    } catch (error) {
      report.error = String(error.stack ?? error);
      console.error(report.error);
    } finally {
      clearTimeout(watchdog);
      fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      app.exit(report.ok ? 0 : 1);
    }
  })();
}
