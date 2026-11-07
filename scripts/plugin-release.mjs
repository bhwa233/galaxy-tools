// Independent plugin releases (Docs/plugin-independent-release.md).
//
//   node scripts/plugin-release.mjs plan [--github-output]
//     Packages every independent plugin without its native component and
//     compares each one with npm. A version that is not on npm yet is due for
//     release; a published version whose fingerprint differs means the plugin
//     changed without a version bump, which fails the run.
//
//   node scripts/plugin-release.mjs publish <pluginId> [--expect <fingerprint>] [--dry-run]
//     Builds one plugin with its native component, checks that its fingerprint
//     matches the plan, and publishes the exact tarball to npm.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const config = JSON.parse(
  await fs.readFile(path.join(project, "scripts/plugin-release.json"), "utf8"),
);
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "github-output": { type: "boolean" },
    expect: { type: "string" },
    "dry-run": { type: "boolean" },
  },
  strict: true,
});
const [command, target] = positionals;
const independent = Object.keys(config.independent);

function build(ids, output, extra = []) {
  execFileSync(
    process.execPath,
    [
      path.join(project, "scripts/build-official-plugins.mjs"),
      "--plugin",
      ids.join(","),
      "--output",
      output,
      ...extra,
    ],
    { cwd: project, stdio: "inherit", windowsHide: true },
  );
  return fs.readFile(path.join(output, "release.json"), "utf8").then(JSON.parse);
}
async function registryDocument(name) {
  const url = new URL(name.replace("/", "%2f"), config.registry);
  // The registry document is cached at the CDN for up to five minutes; a
  // just-published version must not look unpublished.
  url.searchParams.set("cache", String(Date.now()));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Registry lookup failed for ${name}: ${response.status}`);
  return response.json();
}
async function outputDirectory(name) {
  const directory = path.join(project, "local-build/plugin-release", name);
  await fs.rm(directory, { recursive: true, force: true });
  return directory;
}

if (command === "plan") {
  const built = await build(independent, await outputDirectory("plan"), ["--skip-native"]);
  const due = [];
  const drift = [];
  for (const id of independent) {
    const local = built[id];
    const published = (await registryDocument(local.name))?.versions?.[local.version];
    if (!published) {
      due.push({
        id,
        directory: local.directory,
        name: local.name,
        version: local.version,
        fingerprint: local.fingerprint,
      });
      console.log(`${id}: ${local.version} is not on npm yet, due for release`);
    } else if (published.spark233Build?.fingerprint !== local.fingerprint) {
      drift.push(id);
      console.error(
        `${id}: contents changed but ${local.name}@${local.version} is already published. ` +
          `Bump its version in packages/official/*/package.json.`,
      );
    } else console.log(`${id}: ${local.version} is published and unchanged`);
  }
  if (options["github-output"] && process.env.GITHUB_OUTPUT)
    await fs.appendFile(process.env.GITHUB_OUTPUT, `plugins=${JSON.stringify(due)}\n`);
  if (drift.length) process.exit(1);
} else if (command === "publish") {
  if (!independent.includes(target)) throw new Error(`Not an independent plugin: ${target}`);
  const output = await outputDirectory(target);
  const entry = (await build([target], output))[target];
  if (options.expect && entry.fingerprint !== options.expect)
    throw new Error(
      `${target}: the release build fingerprint ${entry.fingerprint} differs from the plan ` +
        `${options.expect}; the package build is not reproducible`,
    );
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["publish", path.join(output, entry.file), "--access", "public"];
  // Provenance links the package to this repository and workflow run.
  if (process.env.GITHUB_ACTIONS === "true") args.push("--provenance");
  if (options["dry-run"]) args.push("--dry-run");
  execFileSync(npm, args, {
    cwd: output,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  console.log(`${options["dry-run"] ? "Checked" : "Published"} ${entry.name}@${entry.version}`);
} else {
  console.error(
    "Usage: plugin-release.mjs plan [--github-output] | publish <pluginId> [--expect <fingerprint>] [--dry-run]",
  );
  process.exit(2);
}
