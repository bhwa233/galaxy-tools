import fs from "node:fs";
const version = process.argv[2]?.replace(/^[vV]/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Usage: npm run version:sync -- 1.2.1");
for (const filename of ["package.json", "package-lock.json"]) {
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  value.version = version;
  if (value.packages?.[""]) value.packages[""].version = version;
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n");
}
console.log(`Electron package version: ${version}`);
