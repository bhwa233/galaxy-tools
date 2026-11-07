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

/**
 * Literal score of a command for an NFKC-lowercased needle against its
 * NFKC-lowercased words (title, keywords, aliases). Besides exact/prefix/substring
 * hits it accepts every-token matches ("note new") and Latin initials ("sn" for
 * "save note"). A single character only matches as a prefix, so typing one letter
 * does not list every command that happens to contain it.
 */
export function literalCommandScore(words: readonly string[], needle: string): number {
  if (!needle) return 1;
  if (words.some((word) => word === needle)) return 100;
  if (words.some((word) => word.startsWith(needle))) return 75;
  const single = [...needle].length === 1;
  if (!single && words.some((word) => word.includes(needle))) return 40;
  const tokens = needle.split(/\s+/u).filter(Boolean);
  if (tokens.length > 1) {
    const parts = words.flatMap((word) => word.split(/[\s\-_/·.]+/u)).filter(Boolean);
    if (tokens.every((token) => parts.some((part) => part.startsWith(token)))) return 60;
    if (tokens.every((token) => parts.some((part) => part.includes(token)))) return 35;
  }
  if (!single && /^[a-z0-9]+$/.test(needle)) {
    const initials = words
      .filter((word) => /^[\p{L}\p{N}\s\-_/·.]+$/u.test(word) && /[a-z]/.test(word))
      .map((word) =>
        word
          .split(/[\s\-_/·.]+/u)
          .filter(Boolean)
          .map((part) => part[0])
          .join(""),
      );
    if (initials.some((value) => value.length > 1 && value === needle)) return 65;
    if (initials.some((value) => value.length > 1 && value.startsWith(needle))) return 45;
  }
  return 0;
}
