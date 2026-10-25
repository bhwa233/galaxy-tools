import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginActivation, JsonValue, PluginContext } from "../packages/sdk/src/index.js";
import { localizePluginManifest, type PluginManifest } from "../packages/sdk/src/index.js";
import type {
  LauncherState,
  LauncherItem,
  LauncherQueryResult,
} from "../src/features/launcher/types.js";
import type { PluginManager } from "./plugins/manager.js";
import { atomicWrite, readJson } from "./persistence.js";
import type { CommandPinyinMatcher } from "./launcher-command-matcher.js";

const querySchema = z.strictObject({
  query: z.string().max(8192),
  mode: z.string().max(170).optional(),
  sessionId: z.string().min(1).max(100),
  directory: z.string().max(32768).optional(),
});
const executeSchema = z.strictObject({
  id: z.string().max(200).optional(),
  pluginId: z.string().max(80),
  commandId: z.string().max(80).optional(),
  context: z.unknown().optional(),
});
const pageSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(512),
        title: z.string().max(1000),
        description: z.string().max(4000).optional(),
        commandId: z.string().max(80),
        parameters: z.json().optional(),
        kind: z.string().max(40).optional(),
        icon: z
          .string()
          .max(32768)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
          .optional(),
        actions: z
          .array(
            z.object({
              title: z.string().min(1).max(160),
              commandId: z.string().min(1).max(80),
              parameters: z.json().optional(),
            }),
          )
          .max(8)
          .optional(),
      }),
    )
    .max(100),
  hint: z.string().optional(),
});
interface LauncherAction {
  pluginId: string;
  activation: PluginActivation;
}
const usageSchema = z.strictObject({
  pluginId: z.string().min(1).max(80),
  commandId: z.string().min(1).max(80),
  count: z.number().int().min(1).max(1_000_000_000),
  lastUsedAt: z.number().int().nonnegative(),
});
const launcherPreferencesSchema = z.strictObject({
  onboardingComplete: z.boolean(),
  commandUsage: z.array(usageSchema).max(256).default([]),
});
const localWord = /^[a-z][a-z' -]{0,120}$/i;
const searchPreviewSchema = z.strictObject({
  path: z.string().max(32768),
  line: z.number().int().min(1),
  snippet: z.string().max(32768),
  text: z.string().max(512 * 1024),
  firstLine: z.number().int().min(1),
});
export interface LauncherOptions {
  stateFile: string;
  manager: () => PluginManager | undefined;
  getContext?: () => { context: PluginContext; label: string } | undefined;
  getLocale?: () => string;
  getWarnings?: () => string[];
  commandMatcher?: CommandPinyinMatcher;
}

// cmdk handles input navigation. The plugin manager supplies command metadata;
// this service handles product ranking, mode routing and opaque action tokens.
export class LauncherController {
  private firstRun: boolean;
  private actions = new Map<string, LauncherAction>();
  private generation = 0;
  private matching?: AbortController;
  private usage: Array<z.infer<typeof usageSchema>> = [];
  constructor(private options: LauncherOptions) {
    const saved = fs.existsSync(options.stateFile)
      ? launcherPreferencesSchema.parse(readJson(options.stateFile))
      : { onboardingComplete: false, commandUsage: [] };
    this.firstRun = !saved.onboardingComplete;
    this.usage = saved.commandUsage;
  }
  state(): LauncherState {
    const manager = this.options.manager();
    return {
      firstRun: this.firstRun,
      pluginsReady: !!manager,
      contextLabel: this.options.getContext?.()?.label,
      warnings: this.options.getWarnings?.(),
      modeOptions: Object.fromEntries(
        (manager?.list() ?? [])
          .filter((record) => record.enabled && !record.lastError)
          .flatMap((record) => {
            const manifest = localizePluginManifest(
              manager!.describe(record.pluginId).spark233,
              this.options.getLocale?.() ?? "zh-CN",
            );
            return manifest.modes.map((mode) => [
              `${record.pluginId}:${mode.id}`,
              { directoryFilter: mode.directoryFilter, placeholder: mode.placeholder },
            ]);
          }),
      ),
      commands: this.commands().map(({ pluginId, command }) => ({
        id: command.id,
        pluginId,
        title: command.title,
        description: command.description,
        keywords: [...command.keywords, ...command.aliases],
        enabled: true,
        ...(command.mode ? { mode: `${pluginId}:${command.mode}` } : {}),
      })),
    };
  }
  private commands() {
    const manager = this.options.manager();
    const localized = new Map<string, PluginManifest>();
    return (manager?.commands() ?? []).map((entry) => {
      const manifest =
        localized.get(entry.pluginId) ??
        localizePluginManifest(
          manager!.describe(entry.pluginId).spark233,
          this.options.getLocale?.() ?? "zh-CN",
        );
      localized.set(entry.pluginId, manifest);
      return {
        pluginId: entry.pluginId,
        sourceTitle: entry.command.title,
        command: manifest.commands.find((command) => command.id === entry.command.id)!,
      };
    });
  }
  completeOnboarding(): void {
    atomicWrite(
      this.options.stateFile,
      JSON.stringify({ onboardingComplete: true, commandUsage: this.usage }),
    );
    this.firstRun = false;
  }
  private remember(pluginId: string, commandId: string): void {
    if (
      !this.commands().some(
        (entry) => entry.pluginId === pluginId && entry.command.id === commandId,
      )
    )
      return;
    const previous = this.usage.find(
      (entry) => entry.pluginId === pluginId && entry.commandId === commandId,
    );
    this.usage = [
      {
        pluginId,
        commandId,
        count: Math.min(1_000_000_000, (previous?.count ?? 0) + 1),
        lastUsedAt: Date.now(),
      },
      ...this.usage.filter((entry) => entry !== previous),
    ].slice(0, 256);
    // Remember only public command identities and counters, never queries,
    // activation text, file handles, private selection tokens or API data.
    try {
      atomicWrite(
        this.options.stateFile,
        JSON.stringify({ onboardingComplete: !this.firstRun, commandUsage: this.usage }),
      );
    } catch (error) {
      console.warn("launcher-command-history", error);
    }
  }
  enterMode(value: unknown): void {
    const { mode } = z.strictObject({ mode: z.string().max(170) }).parse(value);
    const entry = this.commands().find(
      ({ pluginId, command }) => command.mode && `${pluginId}:${command.mode}` === mode,
    );
    if (!entry) throw new Error("Plugin mode is unavailable");
    this.remember(entry.pluginId, entry.command.id);
  }
  clear(): void {
    this.matching?.abort();
    this.matching = undefined;
    this.generation++;
    this.actions.clear();
  }
  private item(
    action: LauncherAction,
    title: string,
    description?: string,
    kind?: string,
    presentation?: Pick<z.infer<typeof pageSchema>["items"][number], "actions" | "icon">,
  ): LauncherItem {
    const id = randomUUID();
    this.actions.set(id, action);
    return {
      id,
      pluginId: action.pluginId,
      commandId: action.activation.commandId,
      title,
      description,
      kind,
      ...(presentation?.icon ? { icon: presentation.icon } : {}),
      ...(presentation?.actions?.length
        ? {
            actions: presentation.actions.map((command) => {
              const id = randomUUID();
              this.actions.set(id, {
                pluginId: action.pluginId,
                activation: {
                  commandId: command.commandId,
                  parameters: command.parameters as JsonValue | undefined,
                },
              });
              return { id, title: command.title, commandId: command.commandId };
            }),
          }
        : {}),
    };
  }
  async query(value: unknown): Promise<LauncherQueryResult> {
    const { query, mode, sessionId, directory } = querySchema.parse(value);
    this.matching?.abort();
    const matching = new AbortController();
    this.matching = matching;
    const generation = ++this.generation;
    this.actions.clear();
    const manager = this.options.manager();
    if (!manager) return { sessionId, items: [], hint: "插件正在准备，请稍后重试" };
    const commands = this.commands();
    if (mode) {
      const entry = commands.find(
        ({ pluginId, command }) => command.mode && `${pluginId}:${command.mode}` === mode,
      );
      if (!entry) return { sessionId, items: [], hint: "此模式所属插件已停用或不可用" };
      const page = pageSchema.parse(
        await manager.query(entry.pluginId, {
          commandId: entry.command.id,
          parameters: {
            action: "search",
            query,
            mode: entry.command.mode!,
            limit: 60,
            ...(directory ? { directory } : {}),
          },
        }),
      );
      if (generation !== this.generation) return { sessionId, items: [] };
      return {
        sessionId,
        hint: page.hint,
        items: page.items.map((item) =>
          this.item(
            {
              pluginId: entry.pluginId,
              activation: {
                commandId: item.commandId,
                parameters: item.parameters as JsonValue | undefined,
              },
            },
            item.title,
            item.description,
            item.kind,
            item,
          ),
        ),
      };
    }
    const needle = query.trim().toLocaleLowerCase();
    const inputContext = this.options.getContext?.()?.context;
    const errors: string[] = [];
    const wordsByCommand = commands.map(({ command, sourceTitle }) =>
      [command.title, sourceTitle, ...command.keywords, ...command.aliases].map((word) =>
        word.toLocaleLowerCase(),
      ),
    );
    const pinyin = await this.options.commandMatcher
      ?.score(wordsByCommand, needle, matching.signal)
      .catch((error: unknown) => {
        if (!matching.signal.aborted) errors.push(String(error));
        return new Map<number, number>();
      });
    if (generation !== this.generation) return { sessionId, items: [] };
    const ranked = commands
      .map((entry, index) => {
        const words = wordsByCommand[index];
        const literalScore = !needle
          ? 1
          : words.some((s) => s === needle)
            ? 100
            : words.some((s) => s.startsWith(needle))
              ? 75
              : words.some((s) => s.includes(needle))
                ? 40
                : 0;
        const score = Math.max(literalScore, pinyin?.get(index) ?? 0);
        const matchesInput = (context: PluginContext) => {
          const rule = entry.command.match;
          return (
            !rule ||
            (rule === "word"
              ? context.kind === "text" && localWord.test(context.text.trim())
              : rule === "text"
                ? context.kind === "text" && !!context.text.trim()
                : context.kind === rule)
          );
        };
        const textInput =
          !!needle &&
          entry.command.inputs.includes("text") &&
          matchesInput({ kind: "text", text: query });
        const contextInput =
          !!inputContext &&
          entry.command.inputs.includes(inputContext.kind) &&
          matchesInput(inputContext);
        const usage = !needle
          ? this.usage.find(
              (item) => item.pluginId === entry.pluginId && item.commandId === entry.command.id,
            )
          : undefined;
        return {
          ...entry,
          score: contextInput ? Math.max(110, score) : score || (textInput ? 10 : 0),
          textInput,
          contextInput,
          usage,
        };
      })
      .filter((entry) => entry.score)
      .sort((a, b) =>
        !needle && !inputContext
          ? (b.usage?.lastUsedAt ?? 0) - (a.usage?.lastUsedAt ?? 0) ||
            (b.usage?.count ?? 0) - (a.usage?.count ?? 0)
          : b.score - a.score,
      );
    const items = ranked
      .slice(0, 40)
      .map(({ pluginId, command, textInput, contextInput, usage }) => ({
        ...this.item(
          {
            pluginId,
            activation: {
              commandId: command.id,
              ...(contextInput
                ? { context: inputContext }
                : textInput
                  ? { context: { kind: "text", text: query } }
                  : {}),
            },
          },
          command.title,
          command.description,
          "command",
        ),
        ...(usage ? { usage: { count: usage.count, lastUsedAt: usage.lastUsedAt } } : {}),
      }));
    // Only manifest-declared local providers participate in default matching.
    // AI actions have no automatic search policy and require explicit execution.
    const providers = commands.filter(
      ({ command }) =>
        needle &&
        (command.search === "default" || (command.search === "word" && localWord.test(needle))),
    );
    const responses = await Promise.allSettled(
      providers.map(async (entry) => ({
        entry,
        page: pageSchema.parse(
          await manager.query(entry.pluginId, {
            commandId: entry.command.id,
            parameters: { action: "search", query, limit: 12 },
          }),
        ),
      })),
    );
    if (generation !== this.generation) return { sessionId, items: [] };
    for (const response of responses) {
      if (response.status === "rejected") {
        errors.push(String(response.reason));
        continue;
      }
      const { entry, page } = response.value;
      for (const item of page.items)
        items.push(
          this.item(
            {
              pluginId: entry.pluginId,
              activation: {
                commandId: item.commandId,
                parameters: item.parameters as JsonValue | undefined,
              },
            },
            item.title,
            item.description,
            item.kind,
            item,
          ),
        );
    }
    return { sessionId, items, ...(errors.length ? { hint: errors.join("; ") } : {}) };
  }
  async execute(value: unknown): Promise<JsonValue | undefined> {
    const input = executeSchema.parse(value);
    const manager = this.options.manager();
    if (!manager) throw new Error("插件宿主尚未就绪");
    const action = input.id ? this.actions.get(input.id) : undefined;
    if (
      input.id &&
      (!action ||
        action.pluginId !== input.pluginId ||
        action.activation.commandId !== input.commandId)
    )
      throw new Error("候选已失效，请重新搜索");
    const command = !action
      ? manager
          .commands()
          .find(
            (entry) => entry.pluginId === input.pluginId && entry.command.id === input.commandId,
          )
      : undefined;
    if (!action && !command) throw new Error("命令已停用或不存在");
    const selected = action ?? {
      pluginId: input.pluginId,
      activation: { commandId: command!.command.id },
    };
    const generation = this.generation;
    {
      const result = await manager.activate(selected.pluginId, selected.activation);
      if (selected.activation.commandId)
        this.remember(selected.pluginId, selected.activation.commandId);
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        Array.isArray(result.items)
      ) {
        if (generation !== this.generation) return;
        const page = pageSchema.parse(result);
        const items = page.items.map((item) =>
          this.item(
            {
              pluginId: selected.pluginId,
              activation: {
                commandId: item.commandId,
                parameters: item.parameters as JsonValue | undefined,
              },
            },
            item.title,
            item.description,
            item.kind,
            item,
          ),
        );
        return JSON.parse(
          JSON.stringify({
            launcherResults: { sessionId: randomUUID(), items, hint: page.hint },
            append: selected.activation.commandId === "next-page",
          }),
        ) as JsonValue;
      }
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        "launcherResults" in result
      )
        throw new Error("Plugins must return search items, not host launcher envelopes");
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        "searchPreview" in result
      ) {
        if (selected.pluginId !== "spark233.search")
          throw new Error("Plugin cannot return the host file preview");
        return { searchPreview: searchPreviewSchema.parse(result.searchPreview) };
      }
      if (result && typeof result === "object" && !Array.isArray(result) && "workspace" in result) {
        const allowed: Record<string, string[]> = {
          ocr: ["spark233.ocr", "spark233.screenshot"],
          translation: ["spark233.translation"],
          clipboard: ["spark233.clipboard"],
        };
        if (
          typeof result.workspace !== "string" ||
          !Object.hasOwn(allowed, result.workspace) ||
          !allowed[result.workspace].includes(selected.pluginId)
        )
          throw new Error("插件返回了未注册的宿主工作区");
      }
      return result;
    }
  }
}
