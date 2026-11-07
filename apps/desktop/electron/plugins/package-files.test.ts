import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolvePackageFile } from "./package-files.js";

test("serves only regular package files inside the root under the surface's policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-files-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "package-outside-"));
  try {
    fs.mkdirSync(path.join(root, "ui"));
    fs.writeFileSync(path.join(root, "ui", "index.html"), "<p>ok</p>");
    fs.writeFileSync(path.join(root, "data.json"), "{}");
    fs.writeFileSync(path.join(outside, "secret.html"), "secret");
    const policy = { extensions: [".html"], maxBytes: () => 1024, rejectPercent: true };
    expect(resolvePackageFile(root, "/ui/index.html", policy)?.mime).toMatch(/text\/html/);
    for (const attempt of [
      "/../" + path.basename(outside) + "/secret.html",
      "/ui/%2e%2e/%2e%2e/" + path.basename(outside) + "/secret.html",
      "/ui/%252e%252e/index.html",
      "/data.json",
      "/ui",
      "/ui/index.html%00",
    ])
      expect(resolvePackageFile(root, attempt, policy), attempt).toBeUndefined();
    expect(resolvePackageFile(root, "/ui/index.html", { ...policy, maxBytes: () => 4 })).toBe(
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
