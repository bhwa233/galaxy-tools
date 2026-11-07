import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { create, extract } from "tar";

// Reuse the production tar reader's npm layout and integrity contract. Packages
// are assembled locally; no install lifecycle or registry publication runs here.
const project = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const root = path.join(project, "packages/official");
const { values: buildOptions } = parseArgs({
  // dev-electron imports this preparation step while retaining app CLI flags.
  args:
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
      ? process.argv.slice(2)
      : [],
  options: {
    plugin: { type: "string" },
    output: { type: "string" },
    "update-registry": { type: "string" },
    "update-channel": { type: "string" },
    renderer: { type: "string" },
    // Package without building or checking native components. The result is
    // not shippable; it only yields release fingerprints (scripts/plugin-release.mjs).
    "skip-native": { type: "boolean" },
    // Take independently released plugins from the npm registry at their
    // source version instead of building them (host release builds).
    published: { type: "boolean" },
  },
  strict: true,
});
// One plugin id, or a comma-separated list.
const selectedPlugin = buildOptions.plugin;
const selectedIds = selectedPlugin ? new Set(selectedPlugin.split(",")) : undefined;
const skipNative = buildOptions["skip-native"] === true;
const releaseConfig = JSON.parse(
  await fs.readFile(path.join(project, "scripts/plugin-release.json"), "utf8"),
);
const usePublished =
  buildOptions.published === true || process.env.SPARK233_PUBLISHED_PLUGINS === "1";
const publishedIds = new Set(usePublished ? Object.keys(releaseConfig.independent) : []);
if (skipNative && usePublished)
  throw new Error("--skip-native cannot be combined with --published");
const updateRegistry = new URL(
  buildOptions["update-registry"] ??
    process.env.SPARK233_PLUGIN_UPDATE_REGISTRY ??
    "https://registry.npmjs.org/",
);
const updateChannel =
  buildOptions["update-channel"] ?? process.env.SPARK233_PLUGIN_UPDATE_CHANNEL ?? "latest";
if (
  updateRegistry.protocol !== "https:" ||
  updateRegistry.username ||
  updateRegistry.password ||
  updateRegistry.search ||
  updateRegistry.hash
)
  throw new Error("Plugin update registry must use HTTPS without credentials, query or fragment");
if (!/^[a-z][a-z0-9._-]{0,127}$/i.test(updateChannel))
  throw new Error("Invalid plugin update channel");
updateRegistry.pathname = updateRegistry.pathname.replace(/\/?$/, "/");
const updateSource = { registry: updateRegistry.href, channel: updateChannel };
const output = path.resolve(
  project,
  buildOptions.output ??
    process.env.SPARK233_DEV_PLUGIN_OUTPUT ??
    (selectedPlugin
      ? path.join("local-build/spark233/plugin-artifacts", selectedPlugin)
      : "dist-plugins"),
);
const expectedIds = new Set(
  [
    "notes",
    "screenshot",
    "ocr",
    "translation",
    "clipboard",
    "applications",
    "search",
    "traffic",
    "quicklinks",
  ].map((name) => `spark233.${name}`),
);
const rendererPlugins = new Set();
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const metadata = JSON.parse(
    await fs.readFile(path.join(root, entry.name, "package.json"), "utf8"),
  );
  if (Object.keys(metadata.spark233?.ui?.windows ?? {}).length)
    rendererPlugins.add(metadata.spark233.id);
}
const uiMetadata = JSON.parse(
  await fs.readFile(path.join(project, "packages/ui/package.json"), "utf8"),
);
for (const id of selectedIds ?? [])
  if (!expectedIds.has(id)) throw new Error(`Unknown official plugin: ${id}`);
const projectRelativeToOutput = path.relative(output, project);
if (
  output === path.parse(output).root ||
  !projectRelativeToOutput ||
  (!path.isAbsolute(projectRelativeToOutput) &&
    projectRelativeToOutput !== ".." &&
    !projectRelativeToOutput.startsWith(`..${path.sep}`))
)
  throw new Error("Plugin output must be a dedicated generated directory");
function run(file, args) {
  execFileSync(file, args, { cwd: project, stdio: "inherit", windowsHide: true });
}
async function exists(filename) {
  try {
    return (await fs.stat(filename)).isFile();
  } catch {
    return false;
  }
}
// Native recipes already discover the portable CMake/MSVC installations. Use
// the same toolchain directory for PowerShell when it is absent from PATH.
let powershellExecutable;
async function powershell() {
  if (powershellExecutable) return powershellExecutable;
  const localTools = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "spark233",
    "toolchains",
  );
  const candidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory.replace(/^"|"$/g, ""), "pwsh.exe"));
  candidates.push(
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
  );
  try {
    const versions = (await fs.readdir(localTools, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^powershell-7\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    candidates.push(...versions.map((version) => path.join(localTools, version, "pwsh.exe")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const candidate of candidates)
    if (await exists(candidate)) return (powershellExecutable = candidate);
  throw new Error(
    "PowerShell 7 is required. Install it on PATH or in LOCALAPPDATA/spark233/toolchains/powershell-7.x.x, then retry pnpm dev.",
  );
}
// A development machine may ship without the native toolchain; prebuilt
// payloads make the toolchain optional, so distinguish "cannot build" from
// "the recipe is broken".
async function hasNativeToolchain() {
  try {
    await powershell();
    return true;
  } catch {
    return false;
  }
}
// Electron's TypeScript path helpers are not built yet. Use native filesystem
// resolution here, limited to generated directories before recursive cleanup.
async function outputPath(relative) {
  const candidate = path.resolve(output, relative);
  const child = path.relative(output, candidate);
  if (!child || child === ".." || child.startsWith(`..${path.sep}`) || path.isAbsolute(child))
    throw new Error("Generated output path escaped the plugin output directory");
  for (let current = candidate; current !== output; current = path.dirname(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Generated output follows a symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return candidate;
}
async function prepareResources(source, metadata) {
  const id = metadata.spark233.id;
  const native = Object.values(metadata.spark233.native ?? {});
  const resourceStatus = await Promise.all(
    native.map(
      async ({ path: entry }) =>
        !(await exists(path.join(source, entry))) ||
        !(await exists(path.join(source, path.dirname(entry), "resources.json"))),
    ),
  );
  let missingNative = resourceStatus.some(Boolean);
  if (id === "spark233.ocr" && !missingNative) {
    const runtimeLock = JSON.parse(
      await fs.readFile(path.join(project, "scripts/native-capture/sources.lock.json"), "utf8"),
    ).ocrDependencies.vcRuntime;
    const resources = JSON.parse(
      await fs.readFile(path.join(source, "native/win32-x64/resources.json"), "utf8"),
    );
    const runtimeFiles = await Promise.all(
      runtimeLock.files.map(async (file) => {
        const filename = path.join(source, "native/win32-x64", file.name);
        return (
          (await exists(filename)) &&
          createHash("sha256")
            .update(await fs.readFile(filename))
            .digest("hex") === file.sha256
        );
      }),
    );
    const licenseFile = path.join(source, "legal", runtimeLock.license.file);
    const licenseMatches =
      (await exists(licenseFile)) &&
      createHash("sha256")
        .update(await fs.readFile(licenseFile))
        .digest("hex") === runtimeLock.license.sha256;
    if (
      resources.runtime?.sha256 !== runtimeLock.sha256 ||
      !licenseMatches ||
      runtimeFiles.some((found) => !found)
    )
      missingNative = true;
  }
  if (id === "spark233.search" && !missingNative) {
    // A staged Pulse payload (or another Everything build) is restaged from the lock.
    const resources = JSON.parse(
      await fs.readFile(path.join(source, "native/resources.json"), "utf8"),
    );
    const lock = JSON.parse(
      await fs.readFile(path.join(project, "scripts/native-everything/sources.lock.json"), "utf8"),
    ).everything;
    if (resources.upstream?.sha256 !== lock.sha256) missingNative = true;
  }
  if (["spark233.clipboard", "spark233.applications"].includes(id) && !missingNative) {
    const resources = JSON.parse(
      await fs.readFile(path.join(source, "native/win32-x64/resources.json"), "utf8"),
    );
    const inputs =
      id === "spark233.clipboard"
        ? [
            "packages/official/clipboard/native-src/service.cpp",
            "packages/official/clipboard/native-src/clipboard-common.h",
            "packages/official/clipboard/native-src/CMakeLists.txt",
          ]
        : [
            "native/applications/matcher.cpp",
            "native/applications/CMakeLists.txt",
            "scripts/native-applications/build.ps1",
            "packages/official/applications/build.mjs",
          ];
    for (const relative of inputs) {
      const current = createHash("sha256")
        .update(await fs.readFile(path.join(project, relative)))
        .digest("hex");
      if (
        !Array.isArray(resources.inputs) ||
        resources.inputs.find((input) => input.path === relative)?.sha256 !== current
      )
        missingNative = true;
    }
  }
  if (id === "spark233.traffic" && !missingNative) {
    const resources = JSON.parse(
      await fs.readFile(path.join(source, "native/resources.json"), "utf8"),
    );
    for await (const filename of fs.glob(
      [
        "native/traffic/**/*.cs",
        "native/traffic/**/*.csproj",
        "native/traffic/**/packages.lock.json",
        "native/traffic/*.props",
        "native/traffic/**/*.manifest",
        "native/traffic/NuGet.Config",
        "scripts/native-traffic/build.ps1",
      ],
      { cwd: project },
    )) {
      if (filename.split(/[\\/]/).some((part) => ["bin", "obj"].includes(part))) continue;
      const relative = filename.replaceAll("\\", "/");
      const hash = createHash("sha256")
        .update(await fs.readFile(path.join(project, filename)))
        .digest("hex");
      if (resources.inputs?.[relative] !== hash) missingNative = true;
    }
  }
  if (missingNative) {
    if (process.env.SPARK233_DEV_SKIP_MISSING_NATIVE === "1" && !(await hasNativeToolchain())) {
      console.warn(
        `Skipping ${id}: its prebuilt native payload is missing and this machine has no native toolchain. ` +
          "Run `pnpm native:fetch --from <release-url>` to enable it.",
      );
      return false;
    }
    if (process.platform !== "win32")
      throw new Error(
        `${id} native payload missing. Build Windows x64 resources on Windows before packaging.`,
      );
    const capture = path.join(project, "local-build/spark233/native-capture-p4/build");
    const clipboard = path.join(project, "local-build/spark233/native-clipboard-p6/build");
    if (id === "spark233.screenshot" || id === "spark233.ocr") {
      const name = id === "spark233.ocr" ? "ImageReader.exe" : "ScreenCapture.exe";
      if (!(await exists(path.join(capture, name))))
        throw new Error(
          `${id} needs a production native build. Run pwsh -File scripts/native-capture/prepare.ps1 -OutputRoot local-build/spark233/native-capture-p4 -SkipReleases; pwsh -File scripts/native-capture/adapt.ps1 -OutputRoot local-build/spark233/native-capture-p4; pwsh -File scripts/native-capture/prepare-ocr-deps.ps1; pwsh -File scripts/native-capture/build.ps1 -OutputRoot local-build/spark233/native-capture-p4 -OpenCVDirectory local-build/spark233/native-capture/deps/opencv/x64/vc18/staticlib -OnnxRuntimeRoot local-build/spark233/native-capture/deps/onnxruntime-win-x64-1.23.2 . Then retry pnpm plugins:build.`,
        );
      run(process.execPath, [path.join(source, "build.mjs"), "--native-build-dir", capture]);
    } else if (id === "spark233.clipboard") {
      run(await powershell(), [
        "-NoProfile",
        "-File",
        "scripts/native-clipboard/build.ps1",
        "-BuildRoot",
        "local-build/spark233/native-clipboard-p6",
      ]);
      run(process.execPath, [path.join(source, "build.mjs"), "--native-build-dir", clipboard]);
    } else if (id === "spark233.applications") {
      run(await powershell(), ["-NoProfile", "-File", "scripts/native-applications/build.ps1"]);
      run(process.execPath, [
        path.join(source, "build.mjs"),
        "--native-build-dir",
        path.join(project, "local-build/spark233/native-applications/build/bin"),
      ]);
    } else if (id === "spark233.search")
      run(process.execPath, ["scripts/native-everything/stage.mjs"]);
    else if (id === "spark233.traffic")
      run(await powershell(), [
        "-NoProfile",
        "-File",
        "scripts/native-traffic/build.ps1",
        "-StageDirectory",
        path.join(source, "native"),
      ]);
    else throw new Error(`No native build recipe for ${id}`);
  }
  for (const { path: entry } of native)
    if (!(await exists(path.join(source, entry))))
      throw new Error(`Missing native entry: ${id}/${entry}`);
  if (id === "spark233.translation") {
    if (!(await exists(path.join(source, "data/ecdict.sqlite"))))
      run(process.env.SPARK233_PYTHON ?? "python", ["scripts/dictionary/build.py"]);
    const provenance = JSON.parse(
      await fs.readFile(path.join(source, "data/provenance.json"), "utf8"),
    );
    const database = await fs.readFile(path.join(source, "data/ecdict.sqlite"));
    if (
      database.length !== provenance.bytes ||
      createHash("sha256").update(database).digest("hex") !== provenance.sha256
    )
      throw new Error(
        "Offline dictionary does not match its provenance; run python scripts/dictionary/build.py",
      );
    if (!(await exists(path.join(source, "data/ECDICT-LICENSE.txt"))))
      throw new Error("Dictionary license is missing");
  }
  for (const { path: entry } of native) {
    const resourceFile = path.join(source, path.dirname(entry), "resources.json");
    const resources = JSON.parse(await fs.readFile(resourceFile, "utf8"));
    if (
      resources.protocol !== 1 ||
      !Array.isArray(resources.files) ||
      !resources.files.length ||
      resources.files.length > 256 ||
      !resources.files.some((resource) => resource.name === path.basename(entry))
    )
      throw new Error(`Invalid native resource manifest: ${id}`);
    const resourceNames = new Set();
    for (const resource of resources.files) {
      if (
        typeof resource.name !== "string" ||
        path.basename(resource.name) !== resource.name ||
        resourceNames.has(resource.name.toLowerCase()) ||
        !Number.isSafeInteger(resource.bytes) ||
        resource.bytes <= 0 ||
        !/^[a-f0-9]{64}$/i.test(resource.sha256)
      )
        throw new Error(`Invalid native resource name: ${resource.name}`);
      resourceNames.add(resource.name.toLowerCase());
      const content = await fs.readFile(path.join(path.dirname(resourceFile), resource.name));
      if (
        content.length !== resource.bytes ||
        createHash("sha256").update(content).digest("hex") !== resource.sha256
      )
        throw new Error(
          `Native resource changed: ${id}/${resource.name}. Re-run its package build.mjs staging command.`,
        );
    }
  }
  if (id === "spark233.search") {
    for (const entry of [
      "native/Everything.lng",
      "licenses/Everything/License.txt",
      "licenses/everything_sdk3/LICENSE",
    ])
      if (!(await exists(path.join(source, entry))))
        throw new Error(
          `Missing search resource ${entry}; run node scripts/native-everything/stage.mjs`,
        );
  }
  return true;
}
async function copyAllowlist(source, destination, metadata) {
  if (!Array.isArray(metadata.files) || !metadata.files.length)
    throw new Error(`${metadata.name} needs an explicit files allowlist`);
  const patterns = [
    "package.json",
    ...metadata.files,
    "LICENSE*",
    "COPYING*",
    "NOTICE*",
    "THIRD_PARTY_NOTICES*",
    "README*",
  ];
  const names = new Set();
  for (const pattern of patterns) {
    if (
      typeof pattern !== "string" ||
      path.isAbsolute(pattern) ||
      pattern.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid package files allowlist");
    for await (const filename of fs.glob(pattern, { cwd: source })) names.add(filename);
  }
  for (const filename of [...names].sort()) {
    if (
      rendererPlugins.has(metadata.spark233.id) &&
      filename.replaceAll("\\", "/").startsWith("renderer/")
    )
      continue;
    for (
      let current = path.join(source, filename);
      current !== source;
      current = path.dirname(current)
    ) {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Package allowlist follows a symlink: ${filename}`);
    }
    const stat = await fs.lstat(path.join(source, filename));
    if (stat.isSymbolicLink()) throw new Error(`Package allowlist contains a symlink: ${filename}`);
    if (!stat.isFile()) continue;
    if (/(?:\.test\.[cm]?[jt]sx?$|(?:^|[/\\])(?:integration|smoke)(?:[-./\\]|$))/i.test(filename))
      throw new Error(`Integration/test source cannot ship in ${metadata.name}: ${filename}`);
    const target = path.join(destination, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, filename), target);
  }
}
async function copyBusinessRenderer(packageRoot, source, metadata) {
  const hostRenderer = path.resolve(
      project,
      buildOptions.renderer
        ? path.join(buildOptions.renderer, metadata.spark233.id)
        : path.join(
            "local-build/plugin-renderers",
            createHash("sha256").update(output).digest("hex").slice(0, 12),
            metadata.spark233.id,
          ),
    ),
    hostAssets = path.join(hostRenderer, "assets");
  if (!buildOptions.renderer) {
    const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
    const { build } = await import(pathToFileURL(require.resolve("vite")).href);
    await build({
      configFile: path.join(project, "apps/desktop/vite.config.ts"),
      root: path.join(source, "renderer"),
      plugins: [
        {
          name: "plugin-renderer-owner",
          generateBundle() {
            const modules = [...this.getModuleIds()].map((id) => id.replaceAll("\\", "/"));
            if (
              modules.some(
                (id) =>
                  id.endsWith("/src/features/launcher/Launcher.tsx") || id.endsWith("/src/App.tsx"),
              )
            )
              throw new Error(
                `Plugin renderer imports the host launcher/router: ${metadata.spark233.id}`,
              );
            this.emitFile({
              type: "asset",
              fileName: "spark233-renderer.json",
              source: JSON.stringify({
                version: 1,
                pluginId: metadata.spark233.id,
                launcherIncluded: false,
                moduleCount: modules.length,
              }),
            });
          },
        },
      ],
      publicDir: false,
      build: {
        outDir: hostRenderer,
        emptyOutDir: true,
        rolldownOptions: { input: path.join(source, "renderer/index.html") },
      },
    });
  }
  const uiPackage = JSON.parse(
    await fs.readFile(path.join(hostRenderer, "spark233-ui.json"), "utf8"),
  );
  const uiSourceHash = createHash("sha256")
    .update(await fs.readFile(path.join(project, "packages/ui/src/components.ts")))
    .digest("hex");
  if (
    uiPackage.name !== uiMetadata.name ||
    uiPackage.version !== uiMetadata.version ||
    JSON.stringify(uiPackage.compatibility) !== JSON.stringify(uiMetadata.spark233Ui) ||
    uiPackage.componentsEntry !== "@spark233/ui/components" ||
    uiPackage.componentSourceSha256 !== uiSourceHash
  )
    throw new Error("Build the current versioned UI renderer before assembling official packages");
  const assets = await fs.readdir(hostAssets, { withFileTypes: true });
  const fonts = [
    { name: "HarmonyOS_Sans_SC.ttf", pattern: /^HarmonyOS_Sans_SC(?:-[a-z0-9_-]+)?\.ttf$/i },
    {
      name: "SourceHanSerifSC-Regular.woff2",
      pattern: /^SourceHanSerifSC-Regular(?:-[a-z0-9_-]+)?\.woff2$/i,
    },
  ].map((font) => {
    const matches = assets.filter((asset) => font.pattern.test(asset.name));
    if (matches.length !== 1 || !matches[0].isFile())
      throw new Error(
        `Build the host renderer with external shared fonts first: missing ${font.name}`,
      );
    return { ...font, file: matches[0].name, url: `spark233://shared/ui/v1/${font.name}` };
  });
  const target = path.join(packageRoot, "renderer"),
    privateWebOrigin = ["spark233.traffic", "spark233.quicklinks"].includes(metadata.spark233.id),
    fontFiles = new Set(privateWebOrigin ? [] : fonts.map((font) => font.file));
  await fs.cp(hostRenderer, target, {
    recursive: true,
    filter: (filename) => !fontFiles.has(path.basename(filename)),
  });
  for (const entry of await fs.readdir(target, { recursive: true, withFileTypes: true })) {
    const filename = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Renderer resource is a symlink: ${entry.name}`);
    if (!entry.isFile() || !/\.(?:html|css|m?js|json|svg)$/i.test(entry.name)) continue;
    const previous = await fs.readFile(filename, "utf8");
    let content = previous;
    for (const font of privateWebOrigin ? [] : fonts)
      content = content.replace(
        new RegExp(`(?:\\.\\.?/assets/|/assets/|assets/|\\./)?${RegExp.escape(font.file)}`, "g"),
        font.url,
      );
    if (content !== previous) await fs.writeFile(filename, content);
  }
  const sharedUi = {
    version: 1,
    uiPackage,
    fonts: Object.fromEntries(
      fonts.map((font) => [font.name, privateWebOrigin ? `./assets/${font.file}` : font.url]),
    ),
  };
  await fs.writeFile(
    path.join(target, "spark233-shared-ui.json"),
    JSON.stringify(sharedUi, null, 2),
  );
  return sharedUi;
}
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const sha512Integrity = (content) =>
  `sha512-${createHash("sha512").update(content).digest("base64")}`;
/**
 * Release fingerprint of a staged package: every packaged file except the
 * native binaries (they are not bit-for-bit reproducible), plus the git blob ids
 * of the native component's sources. A changed fingerprint at an unchanged
 * version means the plugin changed without a version bump.
 */
async function packageFingerprint(packageRoot, metadata) {
  const nativeDirs = Object.values(metadata.spark233.native ?? {}).map(
    ({ path: entry }) => `${path.posix.dirname(entry.replaceAll("\\", "/"))}/`,
  );
  const lines = [];
  for await (const name of fs.glob("**/*", { cwd: packageRoot })) {
    const relative = name.replaceAll("\\", "/");
    const filename = path.join(packageRoot, name);
    if (!(await fs.stat(filename)).isFile()) continue;
    if (nativeDirs.some((directory) => relative.startsWith(directory))) continue;
    lines.push(`file ${relative} ${sha256(await fs.readFile(filename))}`);
  }
  const inputs = releaseConfig.independent[metadata.spark233.id]?.nativeInputs ?? [];
  if (inputs.length) {
    const listed = execFileSync(
      "git",
      ["ls-files", "-s", "--", ...inputs.map((pattern) => `:(glob)${pattern}`)],
      { cwd: project, encoding: "utf8", windowsHide: true },
    );
    for (const line of listed.split("\n").filter(Boolean)) {
      const [stage, file] = line.split("\t");
      lines.push(`native ${file} ${stage.split(" ")[1]}`);
    }
  }
  return `sha256-${sha256(lines.sort().join("\n"))}`;
}
/** The packaged package.json: no workspace-only fields, ready for npm. */
function publishedMetadata(metadata, directory) {
  const value = structuredClone(metadata);
  delete value.private;
  delete value.devDependencies;
  delete value.scripts;
  value.repository = {
    type: "git",
    url: `git+${releaseConfig.repository}`,
    directory: `packages/official/${directory}`,
  };
  value.publishConfig = { access: "public" };
  return value;
}
const registryBase = new URL(releaseConfig.registry);
/**
 * Download an independently released plugin at exactly the source version and
 * check it against the registry's integrity. A just-published version can take
 * a few minutes to appear in the registry document.
 */
async function downloadPublished(metadata) {
  const documentUrl = new URL(metadata.name.replace("/", "%2f"), registryBase);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(documentUrl, { headers: { accept: "application/json" } });
    if (!response.ok && response.status !== 404)
      throw new Error(`Registry lookup failed for ${metadata.name}: ${response.status}`);
    const version = response.ok ? (await response.json()).versions?.[metadata.version] : undefined;
    if (version) {
      const { tarball, integrity } = version.dist ?? {};
      if (typeof tarball !== "string" || !/^sha512-/.test(integrity ?? ""))
        throw new Error(`Registry entry is incomplete: ${metadata.name}@${metadata.version}`);
      const archive = await fetch(tarball);
      if (!archive.ok) throw new Error(`Tarball download failed: ${metadata.name}`);
      const bytes = Buffer.from(await archive.arrayBuffer());
      if (sha512Integrity(bytes) !== integrity)
        throw new Error(`Tarball integrity mismatch: ${metadata.name}@${metadata.version}`);
      return bytes;
    }
    if (attempt >= 10)
      throw new Error(
        `${metadata.name}@${metadata.version} is not published; release the plugin first`,
      );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
if (!selectedIds || [...selectedIds].some((id) => rendererPlugins.has(id) && !publishedIds.has(id)))
  run(process.execPath, [path.join(project, "packages/ui/build.mjs")]);
await fs.mkdir(output, { recursive: true });
if ((await fs.lstat(output)).isSymbolicLink()) throw new Error("Plugin output cannot be a symlink");
if (
  !buildOptions.output &&
  !process.env.SPARK233_DEV_PLUGIN_OUTPUT &&
  !selectedPlugin &&
  path.relative(await fs.realpath(project), await fs.realpath(output)) !== "dist-plugins"
)
  throw new Error("Default plugin output must be the real workspace dist-plugins directory");
const index = [];
const offline = [];
const release = {};
const cleanup = [];
let applicationSource = path.join(root, "applications");
const devBuild = process.env.SPARK233_DEV_PLUGIN_BUILD;
if (devBuild && !/^[0-9]{1,15}$/.test(devBuild)) throw new Error("Invalid development build id");
if (devBuild && process.env.SPARK233_DEV_PLUGIN_OUTPUT) {
  // A launcher reclaiming old generations must leave a concurrent publisher
  // alone, including its new archives before they appear in index.json.
  const marker = await outputPath(`.dev-build-${process.pid}-${devBuild}.active`);
  await fs.writeFile(marker, "", { flag: "wx" });
  process.once("exit", () => {
    try {
      unlinkSync(marker);
    } catch {}
  });
}
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const source = path.join(root, entry.name);
  const metadata = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  if (!metadata.spark233) continue;
  if (devBuild) {
    const parts = metadata.version.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part)))
      throw new Error(`Development build requires a stable version: ${metadata.name}`);
    metadata.version = `${parts[0]}.${parts[1]}.${devBuild}`;
  }
  if (selectedIds && !selectedIds.has(metadata.spark233.id)) continue;
  if (!expectedIds.has(metadata.spark233.id))
    throw new Error(`Unexpected official plugin ${metadata.spark233.id}`);
  const fromRegistry = publishedIds.has(metadata.spark233.id);
  if (fromRegistry && devBuild) throw new Error("Development builds cannot use published plugins");
  if (!fromRegistry && !skipNative && (await prepareResources(source, metadata)) === false)
    continue;

  if (!fromRegistry) {
    if (metadata.spark233.id === "spark233.clipboard")
      run(process.execPath, [path.join(source, "build.mjs"), "--backend-only"]);
    if (metadata.spark233.id === "spark233.notes")
      run(process.execPath, [path.join(source, "build.mjs")]);
    if (metadata.spark233.id === "spark233.traffic")
      run(process.execPath, [path.join(source, "build.mjs")]);
    if (metadata.spark233.id === "spark233.quicklinks")
      run(process.execPath, [path.join(source, "build.mjs")]);
  }
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const work = await fs.mkdtemp(path.join(temporaryRoot, "spark233-package-"));
  if (path.dirname(await fs.realpath(work)) !== temporaryRoot)
    throw new Error("Package staging escaped its temporary directory");
  let keepWork = false;
  try {
    const packageRoot = path.join(work, "package");
    const filename = `${entry.name}-${metadata.version}.tgz`;
    const archive = path.join(output, filename);
    let sharedUi;
    let fingerprint;
    if (fromRegistry) {
      // Ship the exact published bytes so the bundled copy equals the npm release.
      const bytes = await downloadPublished(metadata);
      await fs.writeFile(archive, bytes);
      await extract({ cwd: work, file: archive, strict: true });
      const packaged = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
      );
      if (
        packaged.name !== metadata.name ||
        packaged.version !== metadata.version ||
        packaged.spark233?.id !== metadata.spark233.id
      )
        throw new Error(`Published package identity mismatch: ${metadata.name}`);
      fingerprint = packaged.spark233Build?.fingerprint;
      const sharedFile = path.join(packageRoot, "renderer/spark233-shared-ui.json");
      if (await exists(sharedFile)) sharedUi = JSON.parse(await fs.readFile(sharedFile, "utf8"));
      // The host's command matcher is taken from the applications package.
      if (metadata.spark233.id === "spark233.applications") {
        applicationSource = packageRoot;
        keepWork = true;
      }
    } else {
      await copyAllowlist(source, packageRoot, metadata);
      const packageFile = path.join(packageRoot, "package.json");
      const packaged = publishedMetadata(metadata, entry.name);
      await fs.writeFile(packageFile, JSON.stringify(packaged, null, 2));
      await fs.copyFile(path.join(project, "LICENSE"), path.join(packageRoot, "LICENSE.spark233"));
      if (rendererPlugins.has(metadata.spark233.id)) {
        // Trusted business plugins carry their renderer build. Their windows load
        // the installed version, so a plugin update does not replace the host.
        sharedUi = await copyBusinessRenderer(packageRoot, source, metadata);
        await fs.mkdir(path.join(packageRoot, "legal"), { recursive: true });
        await fs.copyFile(
          path.join(project, "THIRD_PARTY_NOTICES.md"),
          path.join(packageRoot, "legal", "spark233-renderer-THIRD_PARTY_NOTICES.md"),
        );
        await fs.copyFile(
          path.join(project, "apps/desktop/src/assets/fonts/LICENSE_Fonts"),
          path.join(packageRoot, "legal", "HarmonyOS_Fonts.txt"),
        );
        await fs.copyFile(
          path.join(project, "apps/desktop/src/assets/fonts/LICENSE_SourceHanSerif"),
          path.join(packageRoot, "legal", "SourceHanSerif.txt"),
        );
      }
      for await (const name of fs.glob("**/*", { cwd: packageRoot }))
        if ((await fs.lstat(path.join(packageRoot, name))).isSymbolicLink())
          throw new Error(`A packaged resource is a symlink: ${metadata.name}/${name}`);
      fingerprint = await packageFingerprint(packageRoot, metadata);
      packaged.spark233Build = { fingerprint };
      await fs.writeFile(packageFile, JSON.stringify(packaged, null, 2));
      await create({ cwd: work, file: archive, gzip: true, portable: true, noMtime: true }, [
        "package",
      ]);
    }
    const integrity = sha512Integrity(await fs.readFile(archive));
    const iconFile = metadata.spark233.ui?.icon
      ? path.join(fromRegistry ? packageRoot : source, metadata.spark233.ui.icon.png)
      : undefined;
    index.push({
      pluginId: metadata.spark233.id,
      name: metadata.name,
      version: metadata.version,
      displayName: metadata.spark233.displayName,
      ...(iconFile
        ? {
            icon: `data:image/png;base64,${(await fs.readFile(iconFile)).toString("base64")}`,
            iconMonochrome: metadata.spark233.ui.icon.monochrome === true,
          }
        : {}),
      translations: metadata.spark233.translations,
      file: filename,
      integrity,
      updateSource,
    });
    release[metadata.spark233.id] = {
      directory: entry.name,
      name: metadata.name,
      version: metadata.version,
      file: filename,
      fingerprint,
      source: fromRegistry ? "registry" : "build",
    };
    const files = [];
    for await (const name of fs.glob("**/*", { cwd: packageRoot })) {
      const filename = path.join(packageRoot, name);
      if (!(await fs.stat(filename)).isFile()) continue;
      const bytes = await fs.readFile(filename);
      files.push({ path: name.replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) });
    }
    offline.push({
      pluginId: metadata.spark233.id,
      version: metadata.version,
      archiveBytes: (await fs.stat(archive)).size,
      installedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
      ...(sharedUi ? { sharedUi } : {}),
    });
  } finally {
    if (keepWork) cleanup.push(work);
    else await fs.rm(work, { recursive: true, force: true });
  }
}
const expectedCount = selectedIds ? selectedIds.size : expectedIds.size;
// A development run may skip plugins whose prebuilt native payload is absent.
const developmentSkip = process.env.SPARK233_DEV_SKIP_MISSING_NATIVE === "1" && !!devBuild;
const minimumCount = developmentSkip ? 1 : expectedCount;
if (
  index.length < minimumCount ||
  new Set(index.map((entry) => entry.pluginId)).size !== index.length
)
  throw new Error(
    selectedPlugin
      ? "The selected official plugin package is missing"
      : `The offline distribution requires exactly ${expectedCount} official plugin packages`,
  );
if (!selectedPlugin && !buildOptions.output && !process.env.SPARK233_DEV_PLUGIN_OUTPUT)
  for (const name of await fs.readdir(output))
    if (name.endsWith(".tgz") && !index.some((entry) => entry.file === name))
      await fs.unlink(path.join(output, name));
await fs.writeFile(
  path.join(output, "index.json"),
  JSON.stringify({ schemaVersion: 1, plugins: index }, null, 2),
);
await fs.writeFile(
  path.join(output, "resources.json"),
  JSON.stringify({ schemaVersion: 1, plugins: offline }, null, 2),
);
// Release bookkeeping for scripts/plugin-release.mjs; the host never reads it.
await fs.writeFile(path.join(output, "release.json"), JSON.stringify(release, null, 2));
// A live Electron startup may still hold the previous index. Development
// launchers reclaim its archives only after that Electron exits safely.
if (!selectedPlugin && !buildOptions.output && !skipNative) {
  // General launcher commands use the same pinned matcher even while the
  // applications business plugin is disabled. Keep wrapper-relative native
  // paths and provenance in a dedicated host resource, outside app.asar.
  const hostResource = path.join(project, "dist-host/command-matcher");
  for (let current = hostResource; current !== project; current = path.dirname(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Command matcher output follows a symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.rm(hostResource, { recursive: true, force: true });
  await fs.mkdir(path.join(hostResource, "native/win32-x64"), { recursive: true });
  for (const relative of [
    "pinyin.mjs",
    "native/win32-x64/spark233.ApplicationMatcher.exe",
    "native/win32-x64/resources.json",
  ])
    await fs.copyFile(path.join(applicationSource, relative), path.join(hostResource, relative));
  await fs.cp(path.join(applicationSource, "licenses"), path.join(hostResource, "licenses"), {
    recursive: true,
  });
  await fs.copyFile(path.join(project, "LICENSE"), path.join(hostResource, "LICENSE.spark233"));
}
for (const directory of cleanup) await fs.rm(directory, { recursive: true, force: true });
console.log(`Prepared ${index.length} independent official plugin packages in ${output}`);
