import path from "node:path";
import { pathToFileURL } from "node:url";

interface PinyinMatcher {
  match(
    names: string[],
    query: string,
    signal: AbortSignal,
  ): Promise<{ matches: { index: number; kind: "full" | "initials" }[] }>;
  stop(): Promise<void>;
}

export interface CommandPinyinMatcher {
  score(
    words: readonly (readonly string[])[],
    query: string,
    signal: AbortSignal,
  ): Promise<Map<number, number>>;
  stop(): Promise<void>;
}

// Reuse the applications package's pinned native matcher and session controller.
// The build copies those exact assets into host resources, independently of the
// applications plugin's install/enabled state; only command scoring lives here.
export function createCommandPinyinMatcher(options: {
  assetDirectory: string;
  cacheDirectory: string;
}): CommandPinyinMatcher {
  const lifetime = new AbortController();
  let matcher: Promise<PinyinMatcher> | undefined;
  const load = () =>
    (matcher ??= import(pathToFileURL(path.join(options.assetDirectory, "pinyin.mjs")).href).then(
      (module) => {
        lifetime.signal.throwIfAborted();
        return module.createPinyinMatcher({
          cacheDir: options.cacheDirectory,
          signal: lifetime.signal,
        }) as PinyinMatcher;
      },
    ));
  return {
    async score(words, query, signal) {
      lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      const scores = new Map<number, number>();
      // The native query has a 2000 UTF-16-unit bound. Longer arbitrary text
      // remains eligible for the launcher's existing literal/text input paths.
      if (!/[a-z]/i.test(query) || query.length > 2000) return scores;
      const owners = new Map<string, Set<number>>();
      for (const [index, values] of words.entries()) {
        for (const value of values) {
          if (!/\p{Script=Han}/u.test(value)) continue;
          const entries = owners.get(value) ?? new Set<number>();
          entries.add(index);
          owners.set(value, entries);
        }
      }
      if (!owners.size) return scores;
      const names = [...owners.keys()];
      const backend = await load();
      signal.throwIfAborted();
      const result = await backend.match(names, query, signal);
      signal.throwIfAborted();
      for (const match of result.matches) {
        const score = match.kind === "full" ? 55 : 35;
        for (const index of owners.get(names[match.index])!)
          scores.set(index, Math.max(score, scores.get(index) ?? 0));
      }
      return scores;
    },
    async stop() {
      lifetime.abort();
      if (matcher) await (await matcher.catch(() => undefined))?.stop();
    },
  };
}
