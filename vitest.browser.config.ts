import { defineConfig, configDefaults, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import appConfig from "./vite.config.ts";

// Share the application's React/Tailwind plugins and aliases. Keep browser
// discovery separate so the normal Node gate never tries to execute DOM cases.
export default defineConfig(async (env) => {
  const config = mergeConfig(await appConfig(env), {
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    test: {
      name: "launcher-ui",
      attachmentsDir: "local-build/browser-ui/attachments",
      include: [
        "src/features/launcher/*.browser.test.tsx",
        "src/features/settings/*.browser.test.tsx",
      ],
      browser: {
        enabled: true,
        headless: true,
        ui: false,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        viewport: { width: 1100, height: 850 },
        screenshotFailures: true,
        trace: {
          mode: "retain-on-failure",
          tracesDir: "local-build/browser-ui/traces",
        },
        screenshotDirectory: fileURLToPath(
          new URL("./local-build/browser-ui/screenshots", import.meta.url),
        ),
      },
    },
  });
  // Vite merges arrays; replace the Node-only browser exclusion and setup list.
  config.test!.exclude = [...configDefaults.exclude, "**/local-build/**", "**/dist/**"];
  config.test!.setupFiles = ["./src/locales/test-setup.ts", "./src/test/browser/setup.ts"];
  return config;
});
