import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginSettingsService } from "./settings";
import { atomicWrite } from "../persistence";
import { readTranslationSettings, writeTranslationSettings } from "./translation-settings";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark-plugin-settings-"));
  roots.push(root);
  return root;
}
it("serializes explicit commits, rejects stale editors and unknown fields, and never returns a secret", async () => {
  const file = path.join(directory(), "config.json");
  atomicWrite(file, JSON.stringify({ model: "initial", key: "private-fixture-key" }));
  let commits = 0;
  const service = new PluginSettingsService(
    () => ({
      fields: [
        { key: "model", type: "text", label: "Model" },
        { key: "key", type: "secret", label: "Key" },
      ],
      read: () => JSON.parse(fs.readFileSync(file, "utf8")),
      save: async (values) => {
        await Promise.resolve();
        atomicWrite(file, JSON.stringify(values));
        commits++;
      },
    }),
    () => "fixture-installed-version",
  );
  const first = await service.get("fixture.plugin");
  expect(first.values).toEqual({ model: "initial" });
  expect(first.hasSecret).toBe(true);
  expect(commits).toBe(0);
  const results = await Promise.allSettled([
    service.save("fixture.plugin", first.revision, { model: "first-writer" }),
    service.save("fixture.plugin", first.revision, { model: "stale-writer" }),
  ]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "settingsConflict" } });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved).toEqual({ model: "first-writer", key: "private-fixture-key" });
  const next = await service.get("fixture.plugin");
  await expect(
    service.save("fixture.plugin", next.revision, { privilegedPath: "untrusted" }),
  ).rejects.toMatchObject({ code: "invalidPayload" });
  expect(commits).toBe(1);
  await service.save("fixture.plugin", next.revision, { key: "" });
  expect((await service.get("fixture.plugin")).hasSecret).toBe(false);
});
it("persists translation fields and protected key together, rejecting unsafe endpoints before changing disk", () => {
  const file = path.join(directory(), "provider-settings.json"),
    key = randomBytes(32),
    iv = randomBytes(16);
  const encrypt = (text: string) => {
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([cipher.update(text), cipher.final()]);
  };
  const decrypt = (bytes: Buffer) => {
    const cipher = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString();
  };
  writeTranslationSettings(
    file,
    { endpoint: "https://fixture.invalid/v1", model: "fixture", key: "private-secret" },
    encrypt,
  );
  expect(fs.readFileSync(file, "utf8")).not.toContain("private-secret");
  expect(readTranslationSettings(file, decrypt)).toMatchObject({
    endpoint: "https://fixture.invalid/v1/chat/completions",
    model: "fixture",
    key: "private-secret",
  });
  const before = fs.readFileSync(file);
  expect(() =>
    writeTranslationSettings(
      file,
      { endpoint: "https://user:password@fixture.invalid/v1", model: "other", key: "replacement" },
      encrypt,
    ),
  ).toThrow();
  expect(fs.readFileSync(file)).toEqual(before);
  expect(() =>
    writeTranslationSettings(
      file,
      { endpoint: "https://fixture.invalid/v1", model: "other", key: "replacement" },
      () => {
        throw new Error("OS vault unavailable");
      },
    ),
  ).toThrow("OS vault unavailable");
  expect(fs.readFileSync(file)).toEqual(before);
});
