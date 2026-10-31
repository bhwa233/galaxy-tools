import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const host = process.env.ELECTRON_DEV_HOST;
const uiEntry = fileURLToPath(new URL("../../packages/ui/src/components.ts", import.meta.url));
const uiMetadata = JSON.parse(
  readFileSync(new URL("../../packages/ui/package.json", import.meta.url), "utf8"),
);

export default defineConfig(async () => ({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "spark233-ui-package-contract",
      generateBundle() {
        if (
          ![...this.getModuleIds()].some(
            (id) => id.replaceAll("\\", "/") === uiEntry.replaceAll("\\", "/"),
          )
        )
          return;
        this.emitFile({
          type: "asset",
          fileName: "spark233-ui.json",
          source: JSON.stringify(
            {
              name: uiMetadata.name,
              version: uiMetadata.version,
              compatibility: uiMetadata.spark233Ui,
              componentsEntry: "@spark233/ui/components",
              componentSourceSha256: createHash("sha256")
                .update(readFileSync(uiEntry))
                .digest("hex"),
            },
            null,
            2,
          ),
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@spark233/ui/utils": fileURLToPath(
        new URL("../../packages/ui/src/utils.ts", import.meta.url),
      ),
      "@spark233/ui/components": fileURLToPath(
        new URL("../../packages/ui/src/components.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // rehype-katex still declares KaTeX 0.16. Both its renderer and our CSS must
    // resolve to the directly pinned KaTeX version (0.18+ renamed CSS classes).
    dedupe: ["react", "react-dom", "katex"],
  },
  // Shared UI lives outside the desktop root. Discover Base UI controls before
  // rendering so lazy feature imports cannot reload a live React tree.
  optimizeDeps: {
    include: [
      "@base-ui/react/button",
      "@base-ui/react/input",
      "@base-ui/react/use-render",
      "@base-ui/react/merge-props",
      "@base-ui/react/dialog",
      "@base-ui/react/alert-dialog",
      "@base-ui/react/context-menu",
      "@base-ui/react/menu",
      "@base-ui/react/checkbox",
      "@base-ui/react/separator",
      "@base-ui/react/toast",
      "@base-ui/react/toggle",
      "@base-ui/react/toggle-group",
    ],
  },
  clearScreen: false,
  build: {
    assetsInlineLimit: (file: string) =>
      /(?:HarmonyOS_Sans_SC\.ttf|SourceHanSerifSC-Regular\.woff2)$/.test(file) ? false : undefined,
    rolldownOptions: {
      output: {
        // 把体积最大的第三方库拆成独立 chunk：markdown 渲染链（懒加载后
        // 仅预览时才拉取）与基础 vendor 分离，提升窗口间磁盘缓存复用
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "vendor-i18n",
              test: /[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/,
            },
            { name: "vendor-katex", test: /[\\/]node_modules[\\/]katex[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Local packages and isolated Chromium profiles contain locked/generated
      // files, not renderer sources. Watching them causes EBUSY and needless HMR.
      ignored: ["**/dist-electron/**", "**/local-build/**", "**/release-electron/**"],
    },
  },
  test: {
    // GitHub Windows runners are slower than this machine: worker/session tests
    // that need ~3s locally exceed Vitest 5s default there.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // CI runners have fewer cores than this machine; uncapped workers make the
    // dictionary/session tests contend and intermittently fail.
    maxWorkers: process.env.CI ? 4 : undefined,
    include: [
      ...configDefaults.include,
      ...configDefaults.include.map((pattern) => `../../packages/${pattern}`),
    ],
    exclude: [
      ...configDefaults.exclude,
      ...configDefaults.exclude.map((pattern) => `../../packages/${pattern}`),
      "../../packages/**/dist/**",
      "**/.electron-smoke/**",
      "**/local-build/**",
      "**/release-electron/**",
      "**/dist-electron/**",
      "**/dist/**",
      "**/dist-plugins/**",
      "**/*.browser.test.*",
    ],
    setupFiles: ["./src/locales/test-setup.ts"],
  },
}));
