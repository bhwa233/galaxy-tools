// Reuse the production utility controller, resource scope, client and runtime;
// full renderer acceptance targets Windows; this probe exercises durable worker I/O.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";

const repo = fileURLToPath(new URL("../", import.meta.url));
if (!process.versions.electron) {
  const { default: executable } = await import("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    executable,
    [
      ...(process.platform === "linux" ? ["--ozone-platform=headless", "--disable-gpu"] : []),
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env },
  );
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  // Electron emits ready after its main module evaluates; avoid awaiting it at module scope.
  void (async () => {
    const { app } = await import("electron");
    const parent = path.join(repo, "local-build/spark233/notes-backend-probe");
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, "run-"));
    const output =
      process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
      path.join(root, "report.json");
    app.setPath("userData", root);
    const report = { ok: false, root, runtime: process.versions, checks: [], inputs: {} };
    let scope,
      releaseTrash,
      refusing = false,
      finalWrite,
      resumeFault = false;
    const watchdog = setTimeout(() => {
      console.error("Notes backend probe exceeded 60 seconds");
      app.exit(1);
    }, 60_000);
    try {
      await app.whenReady();
      const { createTrustedBackend } = await import("../dist-electron/electron/plugins/backend.js");
      const { PluginResourceScope } =
        await import("../dist-electron/electron/plugins/resources.js");
      const { NotesDataClient } =
        await import("../dist-electron/electron/plugins/official/notes-data-client.js");
      const { createNotesRuntime } =
        await import("../dist-electron/electron/plugins/official/notes.js");
      const pluginRoot = path.join(repo, "packages/official/notes");
      const entryPath = path.join(pluginRoot, "backend.mjs");
      for (const file of [
        entryPath,
        "dist-electron/electron/plugins/backend.js",
        "dist-electron/electron/plugins/backend-worker.js",
        "dist-electron/electron/plugins/resources.js",
        "dist-electron/electron/plugins/official/notes-data-client.js",
        "dist-electron/electron/plugins/official/notes.js",
      ]) {
        const absolute = path.resolve(repo, file);
        report.inputs[path.relative(repo, absolute)] = createHash("sha256")
          .update(fs.readFileSync(absolute))
          .digest("hex");
      }
      const dataDir = path.join(root, "data"),
        cacheDir = path.join(root, "cache");
      let backend,
        client,
        events = [],
        trashMode = "deny",
        trashEntered;
      async function launch() {
        scope = new PluginResourceScope({
          pluginId: "spark233.notes",
          version: "0.1.1",
          instanceId: randomUUID(),
        });
        backend = await createTrustedBackend({
          scope,
          pluginRoot,
          entryPath,
          dataDir,
          cacheDir,
          approveTrust: () => true,
          hostCapabilities: ["storage"],
          timeoutMs: 10_000,
          onLog: (stream, text) => {
            if (stream === "stderr") process.stderr.write(text);
          },
          onEvent: (event) => events.push(event),
          onHostCall: async (call, context) => {
            assert.equal(context.owner.instanceId, scope.owner.instanceId);
            assert.equal(context.signal.aborted, false);
            assert.equal(call.operation, "file.trash");
            assert.equal(path.relative(dataDir, call.path).startsWith(".."), false);
            if (trashMode === "deny") throw new Error("Synthetic trash refusal");
            if (trashMode === "delay")
              await new Promise((resolve) => {
                releaseTrash = resolve;
                trashEntered();
              });
            fs.mkdirSync(path.join(root, "synthetic-trash"), { recursive: true });
            fs.renameSync(call.path, path.join(root, "synthetic-trash", path.basename(call.path)));
          },
        });
        assert.notEqual(backend.pid, process.pid, "Notes engine must execute in another process");
        const startup = NotesDataClient.fromTransport((activation) => backend.activate(activation));
        const runtime = await createNotesRuntime({
          scope,
          backend,
          openManager() {},
          newNote() {},
          openNote() {},
          showOnDesktop() {},
          stop() {},
          start: () => startup.initialize("zh-CN"),
          prepare: async () => {
            if (refusing) return { ok: false, reason: "Synthetic editor save refusal" };
            if (finalWrite) {
              const maintenance = NotesDataClient.fromTransport((activation) =>
                backend.maintenance(activation),
              );
              await finalWrite(maintenance);
              await assert.rejects(() => backend.dispose(), /requires successful prepareStop/);
            }
            return { ok: true };
          },
        });
        client = NotesDataClient.fromTransport((activation) => runtime.activate(activation));
        scope.own("event", {
          cancelStop() {
            if (resumeFault) throw new Error("Synthetic resume refusal");
          },
          dispose() {},
        });
      }
      await launch();
      assert.deepEqual(await client.list(), []);
      await client.createCategory("合成分类");
      const note = await client.save({
        title: "Utility persistence",
        category: "合成分类",
        content: "原始正文",
      });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
        "base64",
      );
      const image = await client.saveImage(note.id, png, "png");
      const content = `原始正文\n![](${image})`;
      await client.save({ ...note, content }, note.id);
      await client.setEditorMode(note.id, "markdown");
      const layout = {
        version: 2,
        windows: [{ noteId: note.id, opaque: ["保持", 17] }],
        capsuleQueues: [],
      };
      await client.putState("layout", layout);
      const reminder = await client.setReminder({
        noteId: note.id,
        fireAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      // Utility extraction once dropped the list payload and cleared every
      // renderer's reminder state even though the reminder had been saved.
      assert.ok(
        events.some(
          (event) =>
            event.name === "reminders-changed" &&
            Array.isArray(event.payload) &&
            event.payload.some((item) => item.id === reminder.id),
        ),
        "Reminder changes must carry the complete renderer snapshot",
      );
      assert.equal((await client.search("原始正文"))[0].id, note.id);
      const metadata = fs.readFileSync(path.join(dataDir, "metadata.json"));
      await assert.rejects(() => client.delete(note.id), /Synthetic trash refusal/);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, "metadata.json")), metadata);
      assert.equal((await client.get(note.id)).content, content);
      assert.equal((await client.listReminders(note.id))[0].id, reminder.id);
      report.checks.push(
        "utility CRUD and refused platform trash preserve metadata/content/reminder",
      );

      await client.startReminders();
      await client.setReminder({
        noteId: note.id,
        taskText: "恢复提醒计时器",
        fireAt: new Date(Date.now() + 100).toISOString(),
      });
      refusing = true;
      const refusal = await scope.prepareStop("disable");
      assert.equal(refusal.ok, false);
      assert.equal(scope.state, "active");
      assert.equal(backend.running, true);
      refusing = false;
      const deadline = Date.now() + 20_000;
      while (
        !events.some(
          (event) =>
            event.name === "notes-reminder-due" &&
            event.payload?.item?.taskText === "恢复提醒计时器",
        )
      ) {
        assert.ok(Date.now() < deadline, "cancelStop must resume the real reminder timer");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      report.checks.push("save refusal retains scope and cancelStop resumes real reminder timer");
      assert.equal((await scope.prepareStop("disable")).ok, true);
      resumeFault = true;
      await assert.rejects(() => scope.cancelStop(), /could not resume/);
      assert.equal(scope.state, "resume-failed");
      assert.equal((await scope.release()).ok, false);
      await assert.rejects(() => client.get(note.id), /pluginDisabled|不可用|not accepting/);
      resumeFault = false;
      assert.equal((await scope.prepareStop("disable")).ok, true);
      await scope.cancelStop();
      assert.equal(scope.state, "active");
      report.checks.push(
        "failed resume fences commands/release and requires fresh preparation before recovery",
      );

      const doomed = await client.save({
        title: "Drained trash",
        category: "",
        content: "只删除此合成正文",
      });
      trashMode = "delay";
      const entered = new Promise((resolve) => {
        trashEntered = resolve;
      });
      const deletion = client.delete(doomed.id);
      await entered;
      let prepared = false;
      finalWrite = (maintenance) => maintenance.append(note.id, "窗口最后一次保存");
      const preparing = scope.prepareStop("update").then((decision) => {
        prepared = true;
        return decision;
      });
      await assert.rejects(
        () => client.append(note.id, "不允许的新写入"),
        /pluginDisabled|不可用|not accepting/,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(prepared, false, "prepare must drain the admitted host effect");
      releaseTrash();
      await deletion;
      assert.equal((await preparing).ok, true);
      assert.equal(scope.state, "prepared");
      await assert.rejects(() => client.get(note.id), /pluginDisabled|不可用|not accepting/);
      const oldOwner = scope.owner,
        oldClient = client;
      assert.deepEqual(await scope.release(), { ok: true, errors: [] });
      assert.equal(backend.running, false);
      assert.equal(scope.accepts(oldOwner), false);
      report.checks.push(
        "prepare drains admitted trash and fences new calls; final write invalidates ack until second prepare",
      );

      finalWrite = undefined;
      events = [];
      await launch();
      const restored = await client.get(note.id);
      assert.equal(restored.id, note.id);
      assert.equal(restored.category, "合成分类");
      assert.equal(restored.editorMode, "markdown");
      assert.equal(restored.content, `${content}\n窗口最后一次保存`);
      assert.deepEqual(fs.readFileSync(await client.resolveImage(image)), png);
      assert.deepEqual(await client.getState("layout"), layout);
      assert.equal((await client.listReminders(note.id))[0].id, reminder.id);
      await assert.rejects(
        () => client.get(doomed.id),
        (error) => error.code === "noteNotFound",
      );
      await assert.rejects(() => oldClient.get(note.id), /pluginDisabled|不可用|not accepting/);
      assert.equal((await client.list()).length, 1);
      report.checks.push(
        "worker restart preserves ID/category/source/mode/attachment/opaque layout/reminder and deletion",
      );
      assert.deepEqual(await scope.stop("quit"), { ok: true, errors: [] });
      report.ok = true;
    } catch (error) {
      report.error = error instanceof Error ? error.stack : String(error);
      console.error(report.error);
    } finally {
      refusing = false;
      resumeFault = false;
      finalWrite = undefined;
      releaseTrash?.();
      if (scope && scope.state !== "released") await scope.stop("quit").catch(() => {});
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, output, checks: report.checks }));
      clearTimeout(watchdog);
      app.exit(report.ok ? 0 : 1);
    }
  })();
}
