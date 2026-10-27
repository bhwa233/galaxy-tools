import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { PluginManager } from "./manager.js";
import { defaultHostEnvironment } from "./manifest.js";
import type { PluginResourceScope } from "./resources.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Reuse the source-command tests' real Manager/package-file fixture pattern;
// controlled resources exercise shutdown recovery without an Electron renderer or process.
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-shutdown-"));
  const versionsRoot = path.join(root, "versions"),
    stateFile = path.join(root, "state.json");
  const plugins: Record<string, unknown> = {};
  for (const name of ["a", "b", "c"]) {
    const pluginId = `fixture.shutdown-${name}`;
    const directory = path.join(versionsRoot, pluginId, "1.0.0");
    fs.mkdirSync(directory, { recursive: true });
    const metadata = {
      name: `@fixture/shutdown-${name}`,
      version: "1.0.0",
      spark233: {
        schemaVersion: 1,
        id: pluginId,
        displayName: `Shutdown ${name}`,
        api: "^1.2.0",
        host: "^1.2.0",
        platforms: [process.platform],
        architectures: [process.arch],
        entry: "index.html",
        activation: "on-startup",
        commands: [{ id: "ping", title: "Ping" }],
      },
    };
    const packageFile = path.join(directory, "package.json");
    fs.writeFileSync(packageFile, JSON.stringify(metadata));
    fs.writeFileSync(path.join(directory, "index.html"), "<p>Owned inert fixture</p>");
    plugins[pluginId] = {
      pluginId,
      packageName: metadata.name,
      version: metadata.version,
      directory,
      enabled: true,
      integrity: "owned-fixture",
      manifestDigest: createHash("sha256").update(fs.readFileSync(packageFile)).digest("hex"),
      source: { kind: "directory", location: directory },
      grant: { capabilities: [], native: false },
    };
  }
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, plugins }));
  const controls = { failRelease: true, failRestart: false };
  const generations = new Map<string, number>();
  const activations = new Map<string, number>();
  const disposals = new Map<string, number>();
  const scopes = new Map<string, PluginResourceScope>();
  const manager = new PluginManager({
    stateFile,
    dataRoot: path.join(root, "data"),
    backupRoot: path.join(root, "backup"),
    packages: {
      versionsRoot,
      stagingRoot: path.join(root, "staging"),
      cacheRoot: path.join(root, "cache"),
    },
    environment: defaultHostEnvironment("1.2.0"),
    createRuntime: async (record, _metadata, scope) => {
      const name = record.pluginId.slice("fixture.shutdown-".length);
      const generation = (generations.get(name) ?? 0) + 1;
      generations.set(name, generation);
      if (name === "a" && generation > 1 && controls.failRestart)
        throw new Error("OWN_A_RESTART_FAILURE");
      scopes.set(name, scope);
      let paused = false;
      scope.own("process", {
        prepareStop: () => {
          paused = true;
          return { ok: true };
        },
        cancelStop: () => {
          paused = false;
        },
        dispose: () => {
          disposals.set(name, (disposals.get(name) ?? 0) + 1);
          if (name === "b" && controls.failRelease) throw new Error("OWN_B_RELEASE_FAILURE");
        },
      });
      return {
        activate: async () => {
          if (paused) throw new Error("Owned service is still paused");
          activations.set(name, (activations.get(name) ?? 0) + 1);
          return { name, generation };
        },
      };
    },
  });
  cleanups.push(async () => {
    controls.failRelease = false;
    controls.failRestart = false;
    try {
      await manager.shutdown();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await manager.initialize();
  return { manager, controls, generations, activations, disposals, scopes };
}

test("cancelled shutdown restores released startup services and resumes later prepared instances", async () => {
  const { manager, controls, activations, disposals, scopes } = await fixture();
  const a = scopes.get("a")!,
    b = scopes.get("b")!,
    c = scopes.get("c")!;
  // Previously: A was gone, B's release failed, C remained prepared forever after quit cancelled.
  await expect(manager.shutdown()).rejects.toThrow("OWN_B_RELEASE_FAILURE");
  expect(a.state).toBe("released");
  expect(scopes.get("a")!.owner.instanceId).not.toBe(a.owner.instanceId);
  expect(activations.get("a")).toBe(2); // The restored on-startup service really activated.
  await expect(manager.activate("fixture.shutdown-a", { commandId: "ping" })).resolves.toEqual({
    name: "a",
    generation: 2,
  });
  expect(scopes.get("c")).toBe(c);
  await expect(manager.activate("fixture.shutdown-c", { commandId: "ping" })).resolves.toEqual({
    name: "c",
    generation: 1,
  });
  expect(c.state).toBe("active");
  expect(b.state).toBe("releasing");
  await expect(manager.activate("fixture.shutdown-b", { commandId: "ping" })).rejects.toThrow(
    /停止|恢复/,
  );
  expect(manager.list().every((record) => record.enabled)).toBe(true);
  controls.failRelease = false;
  await expect(manager.shutdown()).resolves.toBeUndefined();
  expect(disposals.get("b")).toBe(2); // The same failed resource remained tracked for release retry.
  expect(b.state).toBe("released");
});

test("shutdown reports release and recovery failures together while still resuming other instances", async () => {
  const { manager, controls, scopes } = await fixture();
  controls.failRestart = true;
  const failure = await manager.shutdown().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  const messages = (failure as AggregateError).errors.map(String).join("\n");
  expect(messages).toContain("OWN_B_RELEASE_FAILURE");
  expect(messages).toContain("OWN_A_RESTART_FAILURE");
  expect(
    manager.list().find((record) => record.pluginId === "fixture.shutdown-a")?.lastError,
  ).toContain("OWN_A_RESTART_FAILURE");
  expect(scopes.get("b")!.state).toBe("releasing");
  await expect(manager.activate("fixture.shutdown-c", { commandId: "ping" })).resolves.toEqual({
    name: "c",
    generation: 1,
  });
});
