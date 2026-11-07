import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const argument = process.argv.indexOf("--native-build-dir");
if (argument < 0 || !process.argv[argument + 1])
  throw new Error("Supply --native-build-dir with the application matcher bin directory");
const source = path.resolve(process.argv[argument + 1]);
const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const target = path.join(packageRoot, "native/win32-x64");
fs.mkdirSync(target, { recursive: true });
const name = "spark233.ApplicationMatcher.exe",
  content = fs.readFileSync(path.join(source, name));
if (content.toString("ascii", 0, 2) !== "MZ")
  throw new Error("Application matcher is not a Windows executable");
fs.writeFileSync(path.join(target, name), content);
// The native build writes these with CRLF and a BOM; the committed copies use
// LF. Normalize so the packaged files (and the release fingerprint) do not
// depend on where the matcher was built.
for (const entry of fs.readdirSync(path.join(source, "licenses"), { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const text = fs
    .readFileSync(path.join(source, "licenses", entry.name), "utf8")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n");
  fs.writeFileSync(path.join(packageRoot, "licenses", entry.name), text);
}
const inputs = [
  "native/applications/matcher.cpp",
  "native/applications/CMakeLists.txt",
  "scripts/native-applications/build.ps1",
  "packages/official/applications/build.mjs",
].map((relative) => ({
  path: relative,
  sha256: createHash("sha256")
    .update(fs.readFileSync(path.join(repo, relative)))
    .digest("hex"),
}));
fs.writeFileSync(
  path.join(target, "resources.json"),
  JSON.stringify(
    {
      protocol: 1,
      files: [
        { name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") },
      ],
      inputs,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ name, bytes: content.length }));
