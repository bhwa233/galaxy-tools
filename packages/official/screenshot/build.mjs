import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const argument = process.argv.indexOf("--native-build-dir");
if (argument < 0 || !process.argv[argument + 1])
  throw new Error("Supply --native-build-dir with the native CMake build output");
const source = path.resolve(process.argv[argument + 1]);
const target = fileURLToPath(new URL("./native/win32-x64/", import.meta.url));
fs.mkdirSync(target, { recursive: true });
const files = ["ScreenCapture.exe"].map((name) => {
  const content = fs.readFileSync(path.join(source, name));
  if (content.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a Windows binary: ${name}`);
  fs.writeFileSync(path.join(target, name), content);
  return {
    name,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
});
fs.writeFileSync(
  path.join(target, "resources.json"),
  JSON.stringify({ protocol: 1, files }, null, 2),
);
console.log(JSON.stringify({ package: "@spark233/plugin-screenshot", files }, null, 2));
