import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LauncherPreferences,
  launcherTargetKey,
  normalizeLearningKeyword,
  type LauncherPreferenceTarget,
} from "./launcher-preferences.js";

const roots: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-launcher-preferences-"));
  roots.push(directory);
  return path.join(directory, "launcher.json");
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const command: LauncherPreferenceTarget = {
  kind: "command",
  packageName: "@fixture/tools",
  pluginId: "fixture.tools",
  commandId: "open",
};
const application: LauncherPreferenceTarget = {
  kind: "application",
  packageName: "@spark233/plugin-applications",
  pluginId: "spark233.applications",
  applicationId: "a".repeat(64),
};
const presentation = { title: "入口", description: "合成样本" };

// These cases rewrite the preference file repeatedly; on a busy disk a single
// case can exceed the 5s default without any behavioural change.
describe("launcher preference persistence", { timeout: 30_000 }, () => {
  it("upgrades the legacy file without interleaved usage/onboarding writes erasing preferences", () => {
    const file = fixture();
    fs.writeFileSync(
      file,
      JSON.stringify({
        onboardingComplete: false,
        commandUsage: [{ pluginId: command.pluginId, commandId: "open", count: 2, lastUsedAt: 1 }],
      }),
    );
    const preferences = new LauncherPreferences(file);
    expect(preferences.learningEnabled).toBe(false);
    const legacy = fs.readFileSync(file);
    preferences.learn("clip", application);
    expect(fs.readFileSync(file)).toEqual(legacy);
    preferences.setLearningEnabled(true);
    preferences.learn("　ＣＬＩＰ　", command);
    preferences.update(command, presentation, "pin");
    preferences.remember(command.pluginId, "open");
    preferences.update(command, presentation, "aliases", ["clip"]);
    preferences.completeOnboarding();
    preferences.update(command, presentation, "hide");
    preferences.remember(command.pluginId, "open");
    preferences.update(application, presentation, "pin");
    preferences.learn("clip", application);

    const reopened = new LauncherPreferences(file);
    expect(reopened.learningEnabled).toBe(true);
    expect(reopened.learningCount).toBe(1);
    expect(reopened.learningTarget(" Ｃｌｉｐ ")).toEqual(application);
    expect(reopened.firstRun).toBe(false);
    expect(reopened.usage).toMatchObject([
      { pluginId: command.pluginId, commandId: "open", count: 4 },
    ]);
    expect(reopened.find(launcherTargetKey(command))).toMatchObject({
      target: command,
      pinned: true,
      hidden: true,
      aliases: ["clip"],
    });
    expect(reopened.find(launcherTargetKey(application))).toMatchObject({
      target: application,
      pinned: true,
      hidden: false,
    });
  });

  it("keeps explicit pin order independent of usage and moves across unpinned entries", () => {
    const file = fixture();
    const preferences = new LauncherPreferences(file);
    const spacer: LauncherPreferenceTarget = { ...command, commandId: "background" };
    const pinned = () =>
      preferences
        .entries()
        .filter((entry) => entry.pinned)
        .map((entry) => entry.target);
    preferences.update(command, presentation, "pin");
    preferences.update(spacer, presentation, "aliases", ["background"]);
    preferences.update(application, presentation, "pin");
    preferences.remember(command.pluginId, "open");
    preferences.remember(command.pluginId, "open");
    expect(pinned()).toEqual([command, application]);

    preferences.update(application, presentation, "move-up");
    expect(pinned()).toEqual([application, command]);
    preferences.update(application, presentation, "unpin");
    expect(pinned()).toEqual([command]);
    preferences.update(application, presentation, "pin");
    preferences.update(command, presentation, "pin");
    expect(pinned()).toEqual([command, application]);
    expect(preferences.find(launcherTargetKey(spacer))?.aliases).toEqual(["background"]);
    expect(
      new LauncherPreferences(file)
        .entries()
        .filter((entry) => entry.pinned)
        .map((entry) => entry.target),
    ).toEqual([command, application]);
  });

  it("does not transfer same-title preferences across target kinds or package owners", () => {
    const file = fixture();
    const preferences = new LauncherPreferences(file);
    // Deliberately share every identity component except kind, then owner.
    // Titles or a matching opaque ID must not merge three independent targets.
    const sameIdCommand: LauncherPreferenceTarget = {
      kind: "command",
      packageName: application.packageName,
      pluginId: application.pluginId,
      commandId: application.applicationId,
    };
    const otherOwner: LauncherPreferenceTarget = {
      ...sameIdCommand,
      packageName: "@fixture/other-owner",
    };
    const sameTitle = { title: "同名入口" };
    preferences.update(sameIdCommand, sameTitle, "aliases", ["same"]);
    preferences.update(application, sameTitle, "pin");
    preferences.update(application, sameTitle, "aliases", ["same"]);
    preferences.update(otherOwner, sameTitle, "aliases", ["same"]);
    preferences.update(sameIdCommand, sameTitle, "hide");
    preferences.setLearningEnabled(true);
    preferences.learn("command", sameIdCommand);
    preferences.learn("application", application);
    preferences.learn("same owner keyword", sameIdCommand);
    preferences.learn("same owner keyword", otherOwner);
    const before = fs.readFileSync(file);
    expect(() => preferences.update(application, sameTitle, "hide")).toThrow();
    expect(fs.readFileSync(file)).toEqual(before);

    const reopened = new LauncherPreferences(file);
    expect(reopened.learningTarget("command")).toEqual(sameIdCommand);
    expect(reopened.learningTarget("application")).toEqual(application);
    expect(reopened.learningTarget("same owner keyword")).toEqual(otherOwner);
    expect(reopened.find(launcherTargetKey(sameIdCommand))).toMatchObject({
      target: sameIdCommand,
      hidden: true,
      pinned: false,
      aliases: ["same"],
    });
    expect(reopened.find(launcherTargetKey(otherOwner))).toMatchObject({
      target: otherOwner,
      hidden: false,
      pinned: false,
      aliases: ["same"],
    });
    expect(reopened.find(launcherTargetKey(application))).toMatchObject({
      target: application,
      hidden: false,
      pinned: true,
      aliases: ["same"],
    });
  });

  it("normalizes aliases and keeps disk and memory unchanged on validation or write failure", () => {
    const file = fixture();
    const preferences = new LauncherPreferences(file);
    preferences.update(command, presentation, "aliases", ["　Ｃｌｉｐ　", "中文　快捷"]);
    preferences.setLearningEnabled(true);
    preferences.learn("clip", command);
    const revision = preferences.learningRevision;
    expect(preferences.find(launcherTargetKey(command))?.aliases).toEqual(["Clip", "中文 快捷"]);
    const disk = fs.readFileSync(file);
    const entries = preferences.entries();
    expect(() =>
      preferences.update(command, { title: "不得保存" }, "aliases", ["ＣＬＩＰ", "clip"]),
    ).toThrow();
    expect(fs.readFileSync(file)).toEqual(disk);
    expect(preferences.entries()).toEqual(entries);

    // A real rename failure is portable even when chmod is ineffective as root.
    fs.renameSync(file, `${file}.saved`);
    fs.mkdirSync(file);
    try {
      expect(() => preferences.update(command, { title: "写入失败" }, "pin")).toThrow();
      expect(preferences.entries()).toEqual(entries);
      expect(() => preferences.learn("clip", application)).toThrow();
      expect(preferences.learningTarget("clip")).toEqual(command);
      expect(() => preferences.setLearningEnabled(false)).toThrow();
      expect(preferences.learningEnabled).toBe(true);
      expect(preferences.learningRevision).toBe(revision);
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(`${file}.saved`, file);
    }
    expect(fs.readFileSync(file)).toEqual(disk);
    expect(new LauncherPreferences(file).entries()).toEqual(entries);
  });

  it("bounds last successful keyword targets without truncation and keeps opt-out separate from clear", () => {
    const file = fixture();
    const preferences = new LauncherPreferences(file);
    preferences.setLearningEnabled(true);
    const revision = preferences.learningRevision;
    preferences.learn("中".repeat(32), command);
    preferences.learn("中".repeat(33), application);
    preferences.learn("private\nline", application);
    expect(preferences.learningTarget("中".repeat(32))).toEqual(command);
    expect(preferences.learningTarget("private line")).toBeUndefined();
    expect(normalizeLearningKeyword("　ＡＢＣ　　中文　")).toBe("abc 中文");
    expect(normalizeLearningKeyword("😀".repeat(32))).toBe("😀".repeat(32));
    for (let index = 0; index < 129; index++) preferences.learn(`keyword ${index}`, application);
    expect(preferences.learningCount).toBe(128);
    expect(preferences.learningTarget("keyword 0")).toBeUndefined();
    expect(preferences.learningTarget("keyword 128")).toEqual(application);
    expect(preferences.learningRevision).toBe(revision);
    preferences.setLearningEnabled(false);
    const disk = fs.readFileSync(file);
    preferences.learn("keyword 128", command);
    expect(fs.readFileSync(file)).toEqual(disk);
    expect(preferences.learningTarget("keyword 128")).toBeUndefined();
    const reopened = new LauncherPreferences(file);
    expect(reopened.learningEnabled).toBe(false);
    expect(reopened.learningCount).toBe(128);
    reopened.setLearningEnabled(true);
    expect(reopened.learningTarget("keyword 128")).toEqual(application);
    const enabledRevision = reopened.learningRevision;
    reopened.clearLearning();
    expect(reopened.learningRevision).toBe(enabledRevision + 1);
    expect(reopened.learningEnabled).toBe(true);
    expect(new LauncherPreferences(file).learningCount).toBe(0);
  });
});
