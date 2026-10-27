import fs from "node:fs";
import { fileURLToPath } from "node:url";
const version = process.argv[2]?.replace(/^[vV]/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Usage: pnpm version:sync 1.2.1");
for (const relative of ["package.json", "apps/desktop/package.json"]) {
  const filename = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  value.version = version;
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n");
}
console.log(`Electron package version: ${version}`);
