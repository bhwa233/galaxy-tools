import { copyFile } from "node:fs/promises";

// The browser SDK is dependency-free at runtime; ship a local copy so the
// installed example does not depend on workspace links or node_modules.
await copyFile(
  new URL("./browser.js", import.meta.resolve("@spark233/sdk")),
  new URL("./sdk.js", import.meta.url),
);
