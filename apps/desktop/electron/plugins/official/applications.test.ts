import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard, shell } from "electron";
import {
  readSettingsFile,
  writeSettingsFile,
  assertEntryTarget,
} from "../../../../../packages/official/applications/custom-entries.mjs";
import { performIndexedApplicationAction } from "./applications.js";

vi.mock("electron", () => ({
  app: {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  clipboard: { writeText: vi.fn() },
  nativeImage: {},
}));

describe("independent applications document boundaries", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-document-boundary-"));
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists supported documents and rejects unsupported stored/read/write targets without modifying them", async () => {
    const pdf = path.join(directory, "ordinary.PDF");
    const unknown = path.join(directory, "old.unknown");
    fs.writeFileSync(pdf, "Synthetic document; never opened.");
    fs.writeFileSync(unknown, "Synthetic unknown type; never executed.");
    const entry = {
      id: randomUUID(),
      kind: "document",
      title: "PDF",
      path: pdf,
      args: [],
      cwd: "",
    };
    const settings = path.join(directory, "settings.json");
    await writeSettingsFile(settings, [entry]);
    expect((await readSettingsFile(settings))?.entries).toEqual([entry]);
    await expect(assertEntryTarget(entry)).resolves.toBeUndefined();
    const saved = fs.readFileSync(settings);

    const unsupported = { ...entry, path: unknown };
    await expect(writeSettingsFile(settings, [unsupported])).rejects.toThrow();
    expect(fs.readFileSync(settings)).toEqual(saved);
    await expect(assertEntryTarget(unsupported)).rejects.toThrow();

    // Earlier drafts preserved unknown document entries on read/rename. The
    // current contract rejects that configuration instead of retaining it.
    const storedUnknown = path.join(directory, "stored-unknown.json");
    fs.writeFileSync(storedUnknown, JSON.stringify({ version: 2, entries: [unsupported] }));
    const original = fs.readFileSync(storedUnknown);
    await expect(readSettingsFile(storedUnknown)).rejects.toThrow();
    await expect(
      writeSettingsFile(storedUnknown, [{ ...unsupported, title: "Rename refused" }]),
    ).rejects.toThrow();
    expect(fs.readFileSync(storedUnknown)).toEqual(original);
  });

  it("rechecks old backend document descriptors before any Shell operation", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    // Exercise the production Windows dispatch guard on each development OS;
    // only Electron's external side effects are mocked, filesystem checks run.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      for (const name of ["script.ahk", "unknown.custom"]) {
        const target = path.join(directory, name);
        fs.writeFileSync(target, "Synthetic rejected target; never executed.");
        await expect(
          performIndexedApplicationAction({
            action: "launchApplication",
            target: { kind: "document", path: target },
          }),
        ).rejects.toMatchObject({ code: "applicationUnavailable" });
      }
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();

      const pdf = path.join(directory, "ordinary.PDF");
      fs.writeFileSync(pdf, "Synthetic supported target; never opened.");
      await performIndexedApplicationAction({
        action: "copyApplicationPath",
        target: { kind: "document", path: pdf },
      });
      expect(clipboard.writeText).toHaveBeenCalledWith(fs.realpathSync(pdf));
      expect(shell.openPath).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
