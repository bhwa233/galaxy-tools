import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "apps/desktop/src");
const namespaces = {
  translation: "locales/{locale}/translation.json",
  clipboard: "features/clipboard/locales/{locale}.json",
  search: "features/search/locales/{locale}.json",
  applications: "features/applications/locales/{locale}.json",
};
const flatten = (tree, prefix = "") =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [prefix + key] : flatten(value, prefix + key + "."),
  );
const resources = {};
const errors = [];
for (const [namespace, filename] of Object.entries(namespaces)) {
  const locales = Object.fromEntries(
    ["zh-CN", "en-US"].map((locale) => [
      locale,
      new Set(
        flatten(
          JSON.parse(
            fs.readFileSync(path.join(source, filename.replace("{locale}", locale)), "utf8"),
          ),
        ),
      ),
    ]),
  );
  resources[namespace] = locales;
  for (const locale of ["zh-CN", "en-US"])
    for (const key of locales[locale])
      if (!locales[locale === "zh-CN" ? "en-US" : "zh-CN"].has(key))
        errors.push(`${namespace}:${key}: missing from the other raw locale`);
}
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scan(filename);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
    const text = fs.readFileSync(filename, "utf8");
    const namespace =
      /const\s*\{\s*t\s*[,}][^;]*?useTranslation\(\s*["']([^"']+)["']/.exec(text)?.[1] ??
      "translation";
    // Check literal keys across the source tree. Computed keys remain the domain
    // API's responsibility; namespace-local Chinese keys are valid identifiers.
    for (const match of text.matchAll(/\bt\(\s*(["'])([^"'\n]+)\1/g)) {
      const key = match[2];
      const split = key.indexOf(":");
      const ns = split < 0 ? namespace : key.slice(0, split),
        leaf = split < 0 ? key : key.slice(split + 1);
      if (resources[ns] && !resources[ns]["zh-CN"].has(leaf))
        errors.push(`${path.relative(root, filename)}: missing literal key ${ns}:${leaf}`);
    }
  }
}
scan(source);
if (errors.length) {
  console.error([...new Set(errors)].join("\n"));
  process.exitCode = 1;
} else console.log("Raw locale keys and literal translation calls are consistent.");
