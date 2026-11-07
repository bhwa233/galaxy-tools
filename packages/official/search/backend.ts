// File search backend: queries Everything 1.5 over its SDK3 pipe and manages
// the bundled portable instance. Runs in the plugin's own utility process; the
// host only adds its locale and private roots to each activation and performs
// the open / reveal / copy-path actions this backend returns.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BackendContext,
  BackendPlugin,
} from "../../../apps/desktop/electron/plugins/backend-worker.js";
import { createSearchRuntime, type SearchRuntime } from "./search-runtime.js";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

export default function searchBackend(lifetime: BackendContext): BackendPlugin {
  let runtime: SearchRuntime | undefined;
  const current = () =>
    (runtime ??= createSearchRuntime({
      pluginRoot,
      executable: path.join(pluginRoot, "native", "Everything.exe"),
      dataDir: lifetime.dataDir,
      cacheDir: lifetime.cacheDir,
    }));
  return {
    activate: (activation, context) => current().activate(activation, context.signal),
    prepareStop: () => {
      runtime?.revoke();
      return { ok: true };
    },
    cancelStop: () => undefined,
    stop: async () => {
      await runtime?.dispose();
      runtime = undefined;
    },
  };
}
