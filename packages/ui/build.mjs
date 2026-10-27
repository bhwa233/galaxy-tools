import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const source = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(source, "../..");
const { values } = parseArgs({ options: { output: { type: "string" } } });
const destination = values.output ? path.resolve(values.output) : source;
if (destination === project || destination === path.parse(destination).root)
  throw new Error("UI output must be a dedicated package directory");
const work = path.join(project, "local-build/spark233/ui-build", randomUUID());
await fs.mkdir(work, { recursive: true });
const metadata = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
const families = ["button", "alert", "badge", "card", "input", "textarea", "spinner"];
const dist = path.join(destination, "dist");

// Reuse Vite/TypeScript/Tailwind and the installed shadcn sources. No second
// component implementation or host-relative import is shipped to consumers.
await build({
  configFile: false,
  root: source,
  logLevel: "warn",
  plugins: [react()],
  build: {
    outDir: dist,
    emptyOutDir: true,
    lib: {
      entry: {
        components: path.join(source, "src/components.ts"),
        utils: path.join(source, "src/utils.ts"),
      },
      formats: ["es"],
      fileName: (format, name) => `${name}.js`,
    },
    rolldownOptions: {
      external: (id) =>
        Object.keys(metadata.peerDependencies).some(
          (peer) => id === peer || id.startsWith(`${peer}/`),
        ),
    },
  },
});
await build({
  configFile: false,
  root: source,
  logLevel: "warn",
  plugins: [tailwindcss()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    cssCodeSplit: true,
    rolldownOptions: {
      input: path.join(source, "components.css"),
      output: { assetFileNames: "components.css" },
    },
  },
});
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))),
    "-p",
    path.join(source, "tsconfig.json"),
    "--outDir",
    path.join(work, "types"),
  ],
  { cwd: source, stdio: "inherit", windowsHide: true },
);
await fs.cp(path.join(work, "types"), dist, { recursive: true });
for (const file of [
  "package.json",
  "theme.css",
  "semantic.css",
  "theme.mjs",
  "theme.d.ts",
  "README.md",
  "LICENSE",
])
  if (destination !== source)
    await fs.copyFile(path.join(source, file), path.join(destination, file));
const sourceFiles = [
  "packages/ui/package.json",
  "packages/ui/src/components.ts",
  "packages/ui/components.css",
  "packages/ui/semantic.css",
  "packages/ui/theme.css",
  "packages/ui/theme.mjs",
  "packages/ui/src/utils.ts",
  ...families.map((family) => `packages/ui/src/components/${family}.tsx`),
];
const inputs = await Promise.all(
  sourceFiles.map(async (file) => ({
    path: file,
    sha256: createHash("sha256")
      .update(await fs.readFile(path.join(project, file)))
      .digest("hex"),
  })),
);
await fs.writeFile(
  path.join(dist, "build-info.json"),
  JSON.stringify(
    { name: metadata.name, version: metadata.version, compatibility: metadata.spark233Ui, inputs },
    null,
    2,
  ),
);
console.log(`UI package ${metadata.name}@${metadata.version}: ${destination}`);
