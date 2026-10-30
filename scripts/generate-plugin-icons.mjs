import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reuse electron-builder's installed icon converter rather than a second image
// library or a handwritten ICO encoder. The checked-in SVG is the source asset.
const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builder = createRequire(desktop.resolve("electron-builder/package.json"));
const { convertIcon } = builder("app-builder-lib/out/util/iconConverter.js");
const { runIconsTool } = builder("app-builder-lib/out/toolsets/icons.js");
// Native PNG/ICO files cannot inherit browser CSS. Resolve only the SVG's
// explicit theme fallbacks for electron-builder's existing raster converter.
async function rasterSource(source, name, palette) {
  const directory = path.join(root, "local-build/plugin-icon-sources", name);
  await fs.mkdir(directory, { recursive: true });
  const resolved = (await fs.readFile(source, "utf8")).replace(
    /var\((--[a-z-]+),\s*(#[a-f\d]{3,8})\)/gi,
    (_, token, fallback) => palette?.[token] ?? fallback,
  );
  const target = path.join(directory, path.basename(source));
  await fs.writeFile(target, resolved);
  return target;
}
async function generate(directory, name, icon, sourceFile, palette) {
  const output = path.dirname(path.join(directory, icon.png));
  const source = await rasterSource(
    sourceFile ?? path.join(directory, icon.png).replace(/\.png$/i, ".svg"),
    name,
    palette,
  );
  const result = await convertIcon({
    sources: [source],
    fallbackSources: [],
    roots: [directory],
    format: "ico",
    outDir: output,
  });
  if (!result.icons.length) throw new Error(`Could not generate icon for ${name}`);
  const sizes = path.join(root, "local-build/plugin-icon-sizes", name);
  await fs.mkdir(sizes, { recursive: true });
  await runIconsTool({ inputFile: source, outputFormat: "set", outDir: sizes });
  const largest = (await fs.readdir(sizes))
    .filter((name) => /\.png$/i.test(name))
    .toSorted((a, b) => parseInt(b, 10) - parseInt(a, 10))[0];
  if (!largest) throw new Error(`Could not extract PNG for ${name}`);
  await fs.copyFile(path.join(sizes, largest), path.join(directory, icon.png));
  console.log(`Generated ${name} icons`);
  return sizes;
}

// The shared theme CSS remains the palette source for browser and native icons.
const themeCss = await fs.readFile(path.join(root, "packages/ui/theme.css"), "utf8");
function paletteFor(accent, appearance) {
  const selector =
    accent === "green"
      ? appearance === "dark"
        ? ':root[data-theme="dark"]'
        : ":root"
      : (appearance === "dark" ? ':root[data-theme="dark"]' : ":root") +
        `[data-accent="${accent}"]`;
  const offset = themeCss.indexOf(selector + " {");
  if (offset < 0) throw new Error(`Theme palette missing: ${selector}`);
  const block = themeCss.slice(offset + selector.length).split("}")[0];
  const primary = block.match(/--spark233-accent:\s*(#[a-f\d]+);/i)?.[1];
  const foreground = block.match(/--primary-foreground:\s*(#[a-f\d]+);/i)?.[1] ?? "#ffffff";
  if (!primary) throw new Error(`Theme primary missing: ${selector}`);
  return { "--primary": primary, "--primary-foreground": foreground };
}
const staged = [];
async function generateThemes(directory, name, icon) {
  if (!icon.monochrome) return;
  const themes = {};
  const work = [];
  for (const accent of ["green", "blue", "purple", "orange", "rose"]) {
    themes[accent] = {};
    for (const appearance of ["light", "dark"]) {
      const relative = path.posix.join(
        path.posix.dirname(icon.png),
        "theme-icons",
        `${accent}-${appearance}`,
      );
      const files = {
        png: `${relative}/${path.posix.basename(icon.png)}`,
        ico: `${relative}/${path.posix.basename(icon.png).replace(/\.png$/i, ".ico")}`,
      };
      themes[accent][appearance] = files;
      work.push({ accent, appearance, files });
    }
  }
  const stage = path.join(root, "local-build/theme-icon-output", name);
  const source = path.join(directory, icon.png).replace(/\.png$/i, ".svg");
  for (let i = 0; i < work.length; i += 4)
    await Promise.all(
      work
        .slice(i, i + 4)
        .map(({ accent, appearance, files }) =>
          generate(
            stage,
            `${name}.${accent}.${appearance}`,
            files,
            source,
            paletteFor(accent, appearance),
          ),
        ),
    );
  staged.push(async () => {
    await fs.cp(
      path.join(stage, path.posix.dirname(icon.png), "theme-icons"),
      path.join(directory, path.posix.dirname(icon.png), "theme-icons"),
      { recursive: true },
    );
    icon.themes = themes;
  });
}

for (const relative of process.argv.includes("--host-only")
  ? []
  : ["packages/official", "examples/plugins"]) {
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const directory = path.join(root, relative, item.name);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    if (metadata.spark233?.ui?.icon) {
      await generate(directory, metadata.spark233.id, metadata.spark233.ui.icon);
      await generateThemes(directory, metadata.spark233.id, metadata.spark233.ui.icon);
      staged.push(() =>
        fs.writeFile(
          path.join(directory, "package.json"),
          JSON.stringify(metadata, null, 2) + "\n",
        ),
      );
    }
  }
}
const hostRoot = path.join(root, "apps/desktop/electron/assets");
const hosts = JSON.parse(await fs.readFile(path.join(hostRoot, "host-windows.json"), "utf8"));
for (const [id, entry] of Object.entries(hosts)) {
  const sizes = await generate(hostRoot, "host." + id, entry.icon);
  if (id === "launcher")
    await fs.copyFile(path.join(sizes, "32x32.png"), path.join(hostRoot, "32x32.png"));
  await generateThemes(hostRoot, "host." + id, entry.icon);
}
for (const publish of staged) await publish();
await fs.writeFile(path.join(hostRoot, "host-windows.json"), JSON.stringify(hosts, null, 2) + "\n");
for (const variant of ["light", "dark"]) {
  const source = await rasterSource(
    path.join(hostRoot, `tray-${variant}.svg`),
    `host.tray-${variant}`,
  );
  const sizes = path.join(root, "local-build/plugin-icon-sizes", `host.tray-${variant}`);
  await fs.mkdir(sizes, { recursive: true });
  await runIconsTool({ inputFile: source, outputFormat: "set", outDir: sizes });
  await fs.copyFile(path.join(sizes, "32x32.png"), path.join(hostRoot, `tray-${variant}.png`));
}
