import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ClipboardHistory } from "../../../electron/plugins/official/clipboard-history.js";
import { atomicWrite, canonical, confined, inside } from "../../../electron/persistence.js";
import type { BackendContext, BackendPlugin } from "../../../electron/plugins/backend-worker.js";
import type { ClipboardRequest } from "../../../src/features/clipboard/types.js";
import type { JsonValue } from "../../../packages/sdk/src/index.js";

const envelope = z.object({ action: z.string().min(1).max(80) }).passthrough();
const id = z.string().min(1).max(100);
const source = z.strictObject({
  executable: z.string().max(32768),
  title: z.string().max(512),
  pid: z.number().int().nonnegative().optional(),
});
const publicActions = new Set([
  "list",
  "detail",
  "entry",
  "draft.save",
  "draft.remove",
  "update",
  "favorite",
  "history.remove",
  "settings",
  "groups",
  "merge",
  "cleanup.preview",
  "cleanup.confirm",
  "emoji.list",
  "emoji.add",
  "emoji.remove",
  "emoji.used",
  "copied",
  "checkpoint",
]);

/** Independently bundled data backend. Only the trusted native host adapter can
 * provide spool paths; pages never receive access to these internal operations. */
export default function clipboardBackend(lifetime: BackendContext): BackendPlugin {
  const history = new ClipboardHistory(lifetime.dataDir);
  const cache = canonical(lifetime.cacheDir);
  const privateFile = (
    value: unknown,
    extensions: RegExp,
    output = false,
    maximum = 64 * 1024 * 1024 + 8192,
  ) => {
    const candidate = z.string().max(32768).parse(value);
    if (!path.isAbsolute(candidate) || !extensions.test(candidate))
      throw new Error("Invalid clipboard spool file");
    const filename = confined(cache, path.relative(cache, candidate));
    if (!inside(cache, canonical(filename))) throw new Error("Clipboard spool escaped its cache");
    if (output) {
      if (fs.existsSync(filename) || !fs.statSync(path.dirname(filename)).isDirectory())
        throw new Error("Clipboard output must be a fresh spool file");
    } else if (!fs.statSync(filename).isFile() || fs.statSync(filename).size > maximum)
      throw new Error("Clipboard input exceeds its file budget");
    return filename;
  };
  const write = (value: unknown, bytes: Buffer) => {
    const filename = privateFile(value, /\.scb$/i, true);
    atomicWrite(filename, bytes);
    return { file: filename, bytes: bytes.length };
  };
  const json = (value: unknown, detail = false): JsonValue | undefined => {
    const cap = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(cap);
      if (!item || typeof item !== "object") return item;
      const row = item as Record<string, unknown>;
      if (
        typeof row.id === "string" &&
        Array.isArray(row.formats) &&
        typeof row.text === "string"
      ) {
        const limit = detail ? 256 * 1024 : 4096;
        return {
          ...row,
          text: row.text.slice(0, limit),
          textTruncated: !!row.textTruncated || row.text.length > limit,
        };
      }
      return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, cap(child)]));
    };
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(cap(value))) as JsonValue);
  };
  return {
    activate(activation, context) {
      context.signal.throwIfAborted();
      if (activation.commandId !== "data")
        throw new Error("Clipboard data commands are host internal");
      const input = envelope.parse(activation.parameters);
      if (
        !publicActions.has(input.action) &&
        ![
          "native.capture",
          "snapshot",
          "image.export",
          "image.cache",
          "thumbnail.cache",
          "gallery.import",
          "emoji.snapshot",
        ].includes(input.action)
      )
        throw new Error("Unknown clipboard data operation");
      const entryId = () => id.parse(input.id);
      switch (input.action) {
        case "native.capture": {
          const filename = privateFile(input.file, /\.scb$/i),
            captured = history.capture(fs.readFileSync(filename), source.parse(input.source));
          return { captured: !!captured };
        }
        case "snapshot":
          return write(
            input.file,
            history.snapshot(
              entryId(),
              z.enum(["original", "text", "image-file"]).parse(input.mode ?? "original"),
            ),
          );
        case "emoji.snapshot":
          return write(input.file, history.emojiSnapshot(entryId()));
        case "image.export":
          return json({
            ...history.exportImage(entryId()),
            thumbnailReady: history.hasThumbnail(entryId()),
          });
        case "image.cache":
          return json(
            history.cachePng(entryId(), fs.readFileSync(privateFile(input.file, /\.png$/i))),
          );
        case "thumbnail.cache":
          history.cacheThumbnail(
            entryId(),
            fs.readFileSync(privateFile(input.file, /\.png$/i, false, 512 * 1024)),
          );
          return { cached: true };
        case "gallery.import":
          return json(
            history.importImage(
              fs.readFileSync(privateFile(input.file, /\.png$/i, false, 32 * 1024 * 1024)),
              z.string().max(512).parse(input.name),
              input.groupId === undefined ? undefined : id.parse(input.groupId),
            ),
          );
        case "list":
          return json(history.list(input as Extract<ClipboardRequest, { action: "list" }>));
        case "detail":
          return json(history.detail(entryId()), true);
        case "entry": {
          const entry = history.entry(entryId());
          return { id: entry.id, kind: entry.kind };
        }
        case "draft.save":
          return json(
            history.saveDraft({
              action: "draft.save",
              id: entryId(),
              text: z.string().parse(input.text),
              note: z.string().parse(input.note),
              tags: z.string().parse(input.tags),
            }),
          );
        case "draft.remove":
          return json(history.removeDraft(entryId()));
        case "update":
          return json(history.update(input as Extract<ClipboardRequest, { action: "update" }>));
        case "favorite":
          return json(history.favorite(entryId(), z.boolean().parse(input.enabled)));
        case "history.remove":
          return json(history.removeHistory(z.array(id).min(1).max(500).parse(input.ids)));
        case "settings":
          return json(
            input.patch === undefined
              ? history.settings()
              : history.saveSettings(input.patch as never),
          );
        case "groups":
          return json(history.group(input as Extract<ClipboardRequest, { action: "groups" }>));
        case "merge":
          return json(history.merge(input as Extract<ClipboardRequest, { action: "merge" }>));
        case "cleanup.preview":
          return json(
            history.previewCleanup(
              input as Extract<ClipboardRequest, { action: "cleanup.preview" }>,
            ),
          );
        case "cleanup.confirm":
          return json(history.confirmCleanup(z.string().uuid().parse(input.token)));
        case "emoji.list":
          return json(history.emojis());
        case "emoji.add":
          return json(
            history.addEmoji(
              z.string().parse(input.symbol),
              input.name === undefined ? undefined : z.string().parse(input.name),
              input.group === undefined ? undefined : z.string().parse(input.group),
            ),
          );
        case "emoji.remove":
          return json(history.removeEmoji(entryId()));
        case "emoji.used":
          history.usedEmoji(entryId());
          return;
        case "copied":
          history.copied(entryId());
          return;
        case "checkpoint":
          history.checkpoint();
          return { ok: true };
      }
    },
    prepareStop() {
      try {
        history.checkpoint();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    stop() {
      history.close();
    },
  };
}
