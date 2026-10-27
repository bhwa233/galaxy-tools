import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationEntryAdmissions,
  classifyApplicationEntry,
  parseApplicationEntries,
} from "./application-entries.js";
import type { CustomApplicationEntry } from "../src/features/applications/types.js";

describe("custom application entry admission", () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-entry-admission-"));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("grants exact points to one caller and forgets them on document revocation", () => {
    const admissions = new ApplicationEntryAdmissions();
    const child = path.join(directory, "notes.txt");
    fs.writeFileSync(child, "synthetic document");
    const folder: CustomApplicationEntry = {
      id: randomUUID(),
      title: "Folder",
      path: directory,
      kind: "directory",
      args: [],
      cwd: "",
    };
    const document: CustomApplicationEntry = {
      id: randomUUID(),
      title: "Notes",
      path: child,
      kind: "document",
      args: [],
      cwd: "",
    };
    admissions.admit("first-document", directory, "directory");
    expect(admissions.validate("first-document", [], [folder])).toEqual([folder]);
    expect(() => admissions.validate("first-document", [], [document])).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    admissions.admit("first-document", child);
    expect(() => admissions.validate("second-document", [], [document])).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    expect(admissions.validate("first-document", [], [folder, document])).toEqual([
      folder,
      document,
    ]);
    admissions.revoke("first-document");
    expect(() => admissions.validate("first-document", [], [document])).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
  });

  it("keeps legacy identities and argv while allowing missing entries to be renamed or removed", () => {
    const admissions = new ApplicationEntryAdmissions();
    const program = {
      id: randomUUID(),
      title: "Missing program",
      path: path.join(directory, "missing.exe"),
      args: ["--profile", "a b", "literal&argument"],
      cwd: path.join(directory, "missing-work"),
    };
    const shortcut = {
      id: randomUUID(),
      title: "Missing shortcut",
      path: path.join(directory, "missing.lnk"),
      args: [],
      cwd: "",
    };
    const renamed = [{ ...program, title: "Renamed program" }, shortcut];
    expect(admissions.validate("document", [program, shortcut], renamed)).toEqual([
      { ...renamed[0], kind: "program" },
      { ...shortcut, kind: "shortcut" },
    ]);
    expect(admissions.validate("document", [program, shortcut], [])).toEqual([]);

    const replacement = path.join(directory, "replacement.exe");
    fs.writeFileSync(replacement, "not an executable; never launched");
    const changed = [{ ...program, path: replacement }];
    expect(() => admissions.validate("document", [program], changed)).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    admissions.admit("document", replacement);
    expect(admissions.validate("document", [program], changed)).toEqual([
      { ...changed[0], kind: "program" },
    ]);
  });

  it("requires an independent working-directory selection, including empty cwd to program parent", () => {
    const admissions = new ApplicationEntryAdmissions();
    const file = path.join(directory, "program.exe");
    fs.writeFileSync(file, "synthetic program; never launched");
    const program: CustomApplicationEntry = {
      id: randomUUID(),
      title: "Program",
      path: file,
      kind: "program",
      args: ["a b"],
      cwd: "",
    };
    admissions.admit("document", file);
    const saved = admissions.validate("document", [], [program]);
    const withCwd = [{ ...program, cwd: directory }];
    expect(() => admissions.validate("document", saved, withCwd)).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    admissions.admit("document", directory, "directory");
    const updated = admissions.validate("document", saved, withCwd);
    expect(updated).toEqual(withCwd);

    const other = path.join(directory, "other-work");
    fs.mkdirSync(other);
    expect(() => admissions.validate("document", updated, [{ ...program, cwd: other }])).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    admissions.admit("document", other, "directory");
    expect(admissions.validate("document", updated, [{ ...program, cwd: other }])[0].cwd).toBe(
      other,
    );
  });

  it("admits ordinary documents, rejects scripts/unknown types and does not reuse changed target grants", () => {
    const admissions = new ApplicationEntryAdmissions();
    const script = path.join(directory, "script.ps1");
    const installer = path.join(directory, "installer.msi");
    const unlistedScript = path.join(directory, "script.ahk");
    const unknown = path.join(directory, "unknown.custom");
    const pdf = path.join(directory, "ordinary.PDF");
    fs.writeFileSync(script, "synthetic script; never executed");
    fs.writeFileSync(installer, "synthetic installer; never executed");
    fs.writeFileSync(unlistedScript, "synthetic script; never executed");
    fs.writeFileSync(unknown, "unknown type; never opened");
    fs.writeFileSync(pdf, "ordinary document fixture; never opened");
    expect(classifyApplicationEntry(pdf)).toEqual({ path: pdf, kind: "document" });
    for (const file of [script, installer, unlistedScript, unknown]) {
      expect(() => classifyApplicationEntry(file)).toThrow(
        expect.objectContaining({ code: "invalidApplication" }),
      );
      expect(() =>
        parseApplicationEntries([
          {
            id: randomUUID(),
            title: "Forged document",
            path: file,
            kind: "document",
            args: [],
            cwd: "",
          },
        ]),
      ).toThrow(expect.objectContaining({ code: "invalidApplication" }));
    }
    const legacy = {
      id: randomUUID(),
      title: "Stored unknown type",
      path: unknown,
      kind: "document" as const,
      args: [],
      cwd: "",
    };
    expect(() => parseApplicationEntries([legacy])).toThrow(
      expect.objectContaining({ code: "invalidApplication" }),
    );
    expect(() =>
      admissions.validate("document", [legacy], [{ ...legacy, title: "Rename" }]),
    ).toThrow(expect.objectContaining({ code: "invalidApplication" }));
    expect(() => admissions.validate("document", [legacy], [])).toThrow(
      expect.objectContaining({ code: "invalidApplication" }),
    );
    expect(() =>
      admissions.validate("document", [legacy], [{ ...legacy, path: unlistedScript }]),
    ).toThrow();
    expect(() => admissions.validate("document", [], [legacy])).toThrow();
    if (process.platform !== "win32") {
      const disguised = path.join(directory, "document.txt");
      fs.symlinkSync(script, disguised);
      expect(() => admissions.admit("document", disguised)).toThrow(
        expect.objectContaining({ code: "invalidApplication" }),
      );
    }

    // Selection of a folder must not later authorize a program at the same
    // canonical path after filesystem replacement, even within the same caller.
    const selected = path.join(directory, "selected.exe");
    fs.mkdirSync(selected);
    admissions.admit("document", selected, "directory");
    const original: CustomApplicationEntry = {
      id: randomUUID(),
      title: "Selected folder",
      path: selected,
      kind: "directory",
      args: [],
      cwd: "",
    };
    fs.rmdirSync(selected);
    fs.writeFileSync(selected, "synthetic program; never launched");
    const changed = { ...original, kind: "program" as const };
    expect(() => admissions.validate("document", [original], [changed])).toThrow(
      expect.objectContaining({ code: "permissionDenied" }),
    );
    admissions.admit("document", selected);
    expect(admissions.validate("document", [original], [changed])).toEqual([changed]);
  });
});
