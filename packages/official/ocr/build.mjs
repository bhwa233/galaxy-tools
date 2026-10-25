import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const argument = process.argv.indexOf("--native-build-dir");
if (argument < 0 || !process.argv[argument + 1])
  throw new Error("Supply --native-build-dir with the native CMake build output");
const source = path.resolve(process.argv[argument + 1]);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeArgument = process.argv.indexOf("--vc-runtime-dir");
const runtimeRoot =
  runtimeArgument >= 0 && process.argv[runtimeArgument + 1]
    ? path.resolve(process.argv[runtimeArgument + 1])
    : path.join(repo, "local-build/spark233/native-capture/runtime");
const runtimeLock = JSON.parse(
  fs.readFileSync(path.join(repo, "scripts/native-capture/sources.lock.json"), "utf8"),
).ocrDependencies.vcRuntime;
if (
  !fs.existsSync(path.join(runtimeRoot, "provenance.json")) ||
  runtimeLock.files.some((file) => !fs.existsSync(path.join(runtimeRoot, "x64", file.name))) ||
  !fs.existsSync(path.join(runtimeRoot, runtimeLock.license.file)) ||
  !fs.existsSync(path.join(runtimeRoot, "Microsoft-VC-Runtime-LICENSE.txt"))
) {
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      path.join(repo, "scripts/native-capture/prepare-vc-runtime.ps1"),
      "-OutputRoot",
      runtimeRoot,
    ],
    { cwd: repo, stdio: "inherit", windowsHide: true },
  );
}
const runtime = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "provenance.json"), "utf8"));
if (
  runtime.source.sha256 !== runtimeLock.sha256 ||
  runtime.license.sha256 !== runtimeLock.license.sha256
)
  throw new Error("VC runtime provenance does not match the pinned official sources");
if (
  createHash("sha256")
    .update(fs.readFileSync(path.join(runtimeRoot, runtimeLock.license.file)))
    .digest("hex") !== runtimeLock.license.sha256
)
  throw new Error("VC runtime original license does not match its pinned hash");
const target = fileURLToPath(new URL("./native/win32-x64/", import.meta.url));
fs.mkdirSync(target, { recursive: true });
const files = ["ImageReader.exe", "onnxruntime.dll", "onnxruntime_providers_shared.dll"].map(
  (name) => {
    const content = fs.readFileSync(path.join(source, name));
    if (content.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a Windows binary: ${name}`);
    fs.writeFileSync(path.join(target, name), content);
    return {
      name,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  },
);
for (const file of runtimeLock.files) {
  const content = fs.readFileSync(path.join(runtimeRoot, "x64", file.name));
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== file.sha256)
    throw new Error(`VC runtime file differs from its official hash: ${file.name}`);
  fs.writeFileSync(path.join(target, file.name), content);
  files.push({ name: file.name, bytes: content.length, sha256 });
}
const legal = fileURLToPath(new URL("./legal/", import.meta.url));
fs.mkdirSync(legal, { recursive: true });
for (const name of [runtimeLock.license.file, "Microsoft-VC-Runtime-LICENSE.txt"])
  fs.copyFileSync(path.join(runtimeRoot, name), path.join(legal, name));
fs.copyFileSync(
  path.join(runtimeRoot, "provenance.json"),
  path.join(legal, "Microsoft-VC-Runtime-provenance.json"),
);
fs.writeFileSync(
  path.join(target, "resources.json"),
  JSON.stringify({ protocol: 1, files, runtime: runtime.source }, null, 2),
);
console.log(JSON.stringify({ package: "@spark233/plugin-ocr", files }, null, 2));
