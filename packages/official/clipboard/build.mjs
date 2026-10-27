import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const argument = process.argv.indexOf("--native-build-dir");
const source =
  argument >= 0 ? process.argv[argument + 1] : process.env.SPARK233_CLIPBOARD_BUILD_DIR;
const hashFile = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const inputs = (filenames) =>
  filenames.map((filename) => ({
    path: filename,
    sha256: hashFile(path.join(workspace, filename)),
  }));
if (!process.argv.includes("--backend-only")) {
  if (!source) throw new Error("Supply --native-build-dir, or use --backend-only");
  const target = path.join(packageRoot, "native/win32-x64");
  fs.mkdirSync(target, { recursive: true });
  const name = "spark233_clipboard_service.exe",
    content = fs.readFileSync(path.join(path.resolve(source), name));
  if (content.toString("ascii", 0, 2) !== "MZ")
    throw new Error("Not a Windows clipboard helper binary");
  fs.writeFileSync(path.join(target, name), content);
  fs.writeFileSync(
    path.join(target, "resources.json"),
    JSON.stringify(
      {
        protocol: 1,
        inputs: inputs([
          "packages/official/clipboard/native-src/service.cpp",
          "packages/official/clipboard/native-src/clipboard-common.h",
          "packages/official/clipboard/native-src/CMakeLists.txt",
        ]),
        files: [{ name, bytes: content.length, sha256: hashFile(path.join(target, name)) }],
      },
      null,
      2,
    ),
  );
}
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    target: "node24",
    ssr: path.join(packageRoot, "backend.ts"),
    outDir: packageRoot,
    emptyOutDir: false,
    minify: false,
    rolldownOptions: {
      external: (id) => id.startsWith("node:"),
      output: { entryFileNames: "backend.mjs" },
    },
  },
});
const backend = path.join(packageRoot, "backend.mjs");
fs.writeFileSync(
  path.join(packageRoot, "backend-resources.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      inputs: inputs([
        "packages/official/clipboard/backend.ts",
        "apps/desktop/electron/plugins/official/clipboard-history.ts",
        "apps/desktop/electron/persistence.ts",
      ]),
      file: { name: "backend.mjs", bytes: fs.statSync(backend).size, sha256: hashFile(backend) },
    },
    null,
    2,
  ),
);
fs.mkdirSync(path.join(packageRoot, "legal"), { recursive: true });
fs.copyFileSync(
  fileURLToPath(new URL("./LICENSE", import.meta.resolve("zod/package.json"))),
  path.join(packageRoot, "legal/zod-LICENSE.txt"),
);
console.log(`Prepared clipboard backend ${fs.statSync(backend).size} bytes`);
