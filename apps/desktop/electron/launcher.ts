import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginActivation, JsonValue, PluginContext, PluginOwner } from "@spark233/sdk";
import {
  commandMatchesSourceApplication,
  localizePluginManifest,
  type PluginManifest,
} from "@spark233/sdk";
import type {
  LauncherState,
  LauncherItem,
  LauncherQueryResult,
  LauncherResultGroup,
  LauncherPreferenceEntry,
} from "../src/features/launcher/types.js";
import type { PluginManager } from "./plugins/manager.js";
import {
  LauncherPreferences,
  launcherTargetKey,
  normalizeLearningKeyword,
  type LauncherPreferenceTarget,
} from "./launcher-preferences.js";
import type { CommandPinyinMatcher } from "./launcher-command-matcher.js";
import {
  pluginActionCommands,
  pluginEntryCommands,
  pluginKeywordOnlyCommands,
  pluginManagedCommands,
} from "../shared/launcher-entries.js";

const querySchema = z.strictObject({
  query: z.string().max(65536),
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
  instructions: z.string().optional(),
});
interface LauncherAction {
  pluginId: string;
  activation: PluginActivation;
  installation?: string;
  owner?: PluginOwner;
  contextRevision?: number;
  callerId?: string;
  presentation?: { title: string; description?: string };
  learnable?: boolean;
  sourceApplication?: string;
}
interface LauncherSession {
  callerId: string;
  sessionId: string;
  requestId: string;
  revision: number;
  controller: AbortController;
  matching?: AbortController;
  actions: Map<string, LauncherAction>;
  groups: LauncherResultGroup[];
  providers: Map<
    string,
    {
      pluginId: string;
      commandId: string;
      installation?: string;
      controller: AbortController;
      group?: LauncherResultGroup;
    }
  >;
  streaming: boolean;
  learningKeyword?: string;
  sourceApplication?: string;
  contextRevision?: number;
  hint?: string;
}
interface LearningReceipt {
  sessionId: string;
  requestId: string;
  keyword: string;
  target: LauncherPreferenceTarget;
  action: LauncherAction;
  revision: number;
  cancelled: boolean;
  closedByExecution: boolean;
}
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
  getContext?: (callerId?: string) => { context: PluginContext; label: string } | undefined;
  getContextRevision?: (callerId?: string) => number;
  adaptContext?: (
    callerId: string,
    pluginId: string,
    commandId: string,
    context: PluginContext,
  ) => PluginContext | undefined;
  getAvailabilityRevision?: () => number;
  getLocale?: () => string;
  getWarnings?: () => string[];
  commandMatcher?: CommandPinyinMatcher;
  onQueryUpdate?: (callerId: string, result: LauncherQueryResult) => void;
  onPreferencesChanged?: () => void;
  onLearningChanged?: (learning: { enabled: boolean; recordCount: number }) => void;
}

// cmdk handles input navigation. The plugin manager supplies command metadata;
// this service handles product ranking, mode routing and opaque action tokens.
export class LauncherController {
  private preferences: LauncherPreferences;
  private preferenceRevision = 0;
  private applicationAvailability = new Map<string, { installation?: string; found: boolean }>();
  private sessions = new Map<string, LauncherSession>();
  private learningExecutions = new Map<string, LearningReceipt>();
  private catalog?: ReturnType<PluginManager["commands"]>;
  private catalogOwners?: Map<string, boolean>;
  private catalogManifests?: Map<string, PluginManifest>;
  constructor(private options: LauncherOptions) {
    this.preferences = new LauncherPreferences(options.stateFile);
  }
  state(callerId = "internal"): LauncherState {
    return this.withCatalog(() => this.readState(callerId));
  }
  /** Reuse the manager's validated catalog within one synchronous phase only.
   * Never await here: an async operation drops this view as soon as it yields.
   * Query replies and execution still perform their own live owner checks. */
  private withCatalog<T>(operation: () => T): T {
    if (this.catalog) return operation();
    this.catalog = this.options.manager()?.commands(true) ?? [];
    this.catalogOwners = new Map();
    this.catalogManifests = new Map();
    try {
      return operation();
    } finally {
      this.catalog = undefined;
      this.catalogOwners = undefined;
      this.catalogManifests = undefined;
    }
  }
  private publicCommands(): ReturnType<PluginManager["commands"]> {
    return this.catalog ?? this.options.manager()?.commands(true) ?? [];
  }
  private manifest(pluginId: string): PluginManifest {
    const known = this.catalogManifests?.get(pluginId);
    if (known) return known;
    const manifest = localizePluginManifest(
      this.options.manager()!.describe(pluginId, true).spark233,
      this.options.getLocale?.() ?? "zh-CN",
    );
    this.catalogManifests?.set(pluginId, manifest);
    return manifest;
  }
  private ownerCurrent(owner: PluginOwner, commandId?: string): boolean {
    const key = JSON.stringify([owner.pluginId, owner.version, owner.instanceId, commandId]);
    const known = this.catalogOwners?.get(key);
    if (known !== undefined) return known;
    const current = this.options.manager()?.isOwnerCurrent(owner, commandId, true) ?? false;
    this.catalogOwners?.set(key, current);
    return current;
  }
  private readState(callerId: string): LauncherState {
    const manager = this.options.manager();
    const allCommands = this.commands(true);
    const commands = allCommands.filter(
      (entry) =>
        !this.hidden(this.commandTarget(entry.pluginId, entry.command.id)) &&
        this.commandSourceAllowed(entry.pluginId, entry.command.id, callerId),
    );
    const modes = new Set(
      commands
        .filter(({ command }) => command.mode)
        .map(({ pluginId, command }) => `${pluginId}:${command.mode}`),
    );
    return {
      firstRun: this.preferences.firstRun,
      preferenceRevision: this.preferenceRevision,
      learning: {
        enabled: this.preferences.learningEnabled,
        recordCount: this.preferences.learningCount,
      },
      preferences: this.preferenceCatalog(allCommands),
      catalogSignature: JSON.stringify([
        this.options.getAvailabilityRevision?.() ?? 0,
        manager
          ?.list()
          .map((record) => [
            record.pluginId,
            record.version,
            record.integrity,
            record.manifestDigest,
            record.enabled,
            record.lastError,
          ]),
      ]),
      pluginsReady: !!manager,
      contextLabel: this.options.getContext?.(callerId)?.label,
      contextRevision: this.options.getContextRevision?.(callerId),
      warnings: this.options.getWarnings?.(),
      modeOptions: Object.fromEntries(
        (manager?.list() ?? [])
          .filter((record) => record.enabled && !record.lastError)
          .flatMap((record) => {
            const manifest = this.manifest(record.pluginId);
            return manifest.modes
              .filter((mode) => modes.has(`${record.pluginId}:${mode.id}`))
              .map((mode) => [
                `${record.pluginId}:${mode.id}`,
                { directoryFilter: mode.directoryFilter, placeholder: mode.placeholder },
              ]);
          }),
      ),
      commands: commands.map(({ pluginId, command }) => ({
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
  private commands(includeHidden = false, callerId?: string) {
    const localized = new Map<string, PluginManifest>();
    return this.publicCommands()
      .filter(
        (entry) =>
          includeHidden || !this.hidden(this.commandTarget(entry.pluginId, entry.command.id)),
      )
      .map((entry) => {
        const manifest = localized.get(entry.pluginId) ?? this.manifest(entry.pluginId);
        localized.set(entry.pluginId, manifest);
        const command = manifest.commands.find((command) => command.id === entry.command.id)!;
        const personal = this.preferences.find(
          launcherTargetKey(this.commandTarget(entry.pluginId, command.id)!),
        );
        return {
          pluginId: entry.pluginId,
          sourceTitle: entry.command.title,
          command: { ...command, aliases: [...command.aliases, ...(personal?.aliases ?? [])] },
        };
      })
      .filter(
        (entry) =>
          callerId === undefined ||
          commandMatchesSourceApplication(
            entry.command,
            this.options.getContext?.(callerId)?.context,
          ),
      );
  }
  completeOnboarding(): void {
    this.preferences.completeOnboarding();
  }
  private remember(pluginId: string, commandId: string): void {
    if (
      !this.commands(true).some(
        (entry) => entry.pluginId === pluginId && entry.command.id === commandId,
      )
    )
      return;
    try {
      this.preferences.remember(pluginId, commandId);
    } catch (error) {
      console.warn("launcher-command-history", error);
    }
  }
  private commandTarget(pluginId: string, commandId: string): LauncherPreferenceTarget | undefined {
    const record = this.options
      .manager()
      ?.list()
      .find((entry) => entry.pluginId === pluginId);
    return record
      ? { kind: "command", packageName: record.packageName, pluginId, commandId }
      : undefined;
  }
  private hidden(target: LauncherPreferenceTarget | undefined): boolean {
    return !!target && !!this.preferences.find(launcherTargetKey(target))?.hidden;
  }
  private commandHidden(pluginId: string, commandId: string): boolean {
    return (
      this.publicCommands().some(
        (entry) => entry.pluginId === pluginId && entry.command.id === commandId,
      ) && this.hidden(this.commandTarget(pluginId, commandId))
    );
  }
  private declaredCommand(pluginId: string, commandId?: string) {
    try {
      return this.manifest(pluginId).commands.find((command) => command.id === commandId);
    } catch {
      return undefined;
    }
  }
  private commandSourceAllowed(pluginId: string, commandId?: string, callerId?: string): boolean {
    const command = this.declaredCommand(pluginId, commandId);
    return (
      !command ||
      commandMatchesSourceApplication(command, this.options.getContext?.(callerId)?.context)
    );
  }
  private providerContext(
    callerId: string,
    pluginId: string,
    commandId?: string,
    context = this.options.getContext?.(callerId)?.context,
  ) {
    const command = this.declaredCommand(pluginId, commandId);
    // Existing providers retain their original parameter-only activation. Only
    // commands explicitly using this API's source/window contract gain context.
    if (!command || !context) return;
    if (
      !command.sourceApplications &&
      !command.inputs.includes("window") &&
      command.match !== "window"
    )
      return;
    if (command.match !== "window" && command.inputs.includes(context.kind)) return context;
    return context.sourceApplication
      ? { kind: "window" as const, sourceApplication: context.sourceApplication }
      : undefined;
  }
  private actionTarget(action: LauncherAction): LauncherPreferenceTarget | undefined {
    const manager = this.options.manager();
    const record = manager?.list().find((entry) => entry.pluginId === action.pluginId);
    if (!record) return;
    if (
      record.packageName === "@spark233/plugin-applications" &&
      action.pluginId === "spark233.applications" &&
      action.activation.commandId === "launch"
    ) {
      const parameters = action.activation.parameters;
      if (
        parameters &&
        typeof parameters === "object" &&
        !Array.isArray(parameters) &&
        parameters.action === "launch" &&
        typeof parameters.id === "string" &&
        /^[a-f0-9]{64}$/.test(parameters.id)
      )
        return {
          kind: "application",
          packageName: record.packageName,
          pluginId: action.pluginId,
          applicationId: parameters.id,
        };
    }
    if (
      this.publicCommands().some(
        (entry) =>
          entry.pluginId === action.pluginId && entry.command.id === action.activation.commandId,
      )
    )
      return this.commandTarget(action.pluginId, action.activation.commandId!);
  }
  private targetAvailable(target: LauncherPreferenceTarget): boolean {
    const manager = this.options.manager();
    const record = manager?.list().find((entry) => entry.pluginId === target.pluginId);
    if (!record?.enabled || record.lastError || record.packageName !== target.packageName)
      return false;
    if (target.kind === "command")
      return this.publicCommands().some(
        (entry) => entry.pluginId === target.pluginId && entry.command.id === target.commandId,
      );
    const cached = this.applicationAvailability.get(launcherTargetKey(target));
    return (
      !!cached?.found &&
      cached.installation === this.installation(target.pluginId) &&
      !this.hidden(this.commandTarget(target.pluginId, "search"))
    );
  }
  private preferenceEntry(
    target: LauncherPreferenceTarget,
    title: string,
    description?: string,
    available = this.targetAvailable(target),
  ): LauncherPreferenceEntry {
    const key = launcherTargetKey(target);
    const saved = this.preferences.find(key);
    return {
      key,
      kind: target.kind,
      pluginId: target.pluginId,
      ...(target.kind === "command" ? { commandId: target.commandId } : {}),
      title,
      ...(description ? { description } : {}),
      available,
      pinned: saved?.pinned ?? false,
      hidden: saved?.hidden ?? false,
      aliases: saved?.aliases ?? [],
    };
  }
  private preferenceCatalog(commands = this.commands(true)): LauncherPreferenceEntry[] {
    const entries = new Map<string, LauncherPreferenceEntry>();
    for (const saved of this.preferences.entries()) {
      const entry = this.preferenceEntry(saved.target, saved.title, saved.description);
      entries.set(entry.key, entry);
    }
    for (const { pluginId, command } of commands) {
      const target = this.commandTarget(pluginId, command.id)!;
      const entry = this.preferenceEntry(target, command.title, command.description);
      entries.set(entry.key, entry);
    }
    return [...entries.values()];
  }
  private applicationIds(query: string, pinnedOnly = false, learningKeyword?: string): string[] {
    if (
      this.options
        .manager()
        ?.list()
        .find((entry) => entry.pluginId === "spark233.applications")?.packageName !==
      "@spark233/plugin-applications"
    )
      return [];
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    const ids = this.preferences
      .entries()
      .filter(
        (entry) =>
          entry.target.kind === "application" &&
          (pinnedOnly
            ? entry.pinned
            : !!needle &&
              entry.aliases.some((alias) => alias.toLocaleLowerCase().includes(needle))),
      )
      .slice(0, 100)
      .map(
        (entry) =>
          (entry.target as Extract<LauncherPreferenceTarget, { kind: "application" }>)
            .applicationId,
      );
    const learned =
      !pinnedOnly && learningKeyword ? this.preferences.learningTarget(learningKeyword) : undefined;
    if (learned?.kind === "application" && ids.length < 100 && !ids.includes(learned.applicationId))
      ids.push(learned.applicationId);
    return ids;
  }
  updatePreference(value: unknown, callerId: string): LauncherState {
    const input = z
      .strictObject({
        key: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        selectionId: z.string().min(1).max(200).optional(),
        operation: z.enum([
          "pin",
          "unpin",
          "aliases",
          "hide",
          "show",
          "move-up",
          "move-down",
          "remove",
        ]),
        aliases: z.array(z.string().max(80)).max(8).optional(),
      })
      .refine(
        (entry) => !!entry.key !== !!entry.selectionId,
        "Choose an existing entry or a current result",
      )
      .refine(
        (entry) => (entry.operation === "aliases") === (entry.aliases !== undefined),
        "Aliases are only accepted for an alias edit",
      )
      .parse(value);
    let target: LauncherPreferenceTarget | undefined;
    let presentation: { title: string; description?: string } | undefined;
    if (input.selectionId) {
      const action = this.sessions.get(callerId)?.actions.get(input.selectionId);
      if (!action || !this.available(action)) throw new Error("候选已失效，请重新搜索");
      target = this.actionTarget(action);
      presentation = action.presentation;
    } else {
      const saved = this.preferences.find(input.key!);
      if (saved) {
        target = saved.target;
        presentation = saved;
      } else
        for (const { pluginId, command } of this.commands(true)) {
          const candidate = this.commandTarget(pluginId, command.id)!;
          if (launcherTargetKey(candidate) === input.key) {
            target = candidate;
            presentation = { title: command.title, description: command.description };
            break;
          }
        }
    }
    if (!target || !presentation) throw new Error("此结果不支持入口偏好，请选择应用或公开命令");
    this.preferences.update(target, presentation, input.operation, input.aliases);
    const key = launcherTargetKey(target);
    if (input.operation === "remove") this.applicationAvailability.delete(key);
    else if (target.kind === "application" && input.selectionId)
      this.applicationAvailability.set(key, {
        installation: this.installation(target.pluginId),
        found: true,
      });
    this.preferenceRevision++;
    this.clear();
    this.options.onPreferencesChanged?.();
    return this.state(callerId);
  }
  updateLearning(value: unknown, callerId = "internal"): LauncherState {
    const input = z
      .union([z.strictObject({ enabled: z.boolean() }), z.strictObject({ clear: z.literal(true) })])
      .parse(value);
    if ("enabled" in input) this.preferences.setLearningEnabled(input.enabled);
    else this.preferences.clearLearning();
    this.preferenceRevision++;
    this.clear();
    this.notifyLearning();
    this.options.onPreferencesChanged?.();
    return this.state(callerId);
  }
  private notifyLearning(): void {
    try {
      this.options.onLearningChanged?.({
        enabled: this.preferences.learningEnabled,
        recordCount: this.preferences.learningCount,
      });
    } catch {
      console.warn("launcher-learning-notification-failed");
    }
  }
  private learningChoice(session: LauncherSession): LauncherPreferenceTarget | undefined {
    return session.learningKeyword
      ? this.preferences.learningTarget(session.learningKeyword)
      : undefined;
  }
  private beginLearning(
    session: LauncherSession | undefined,
    action: LauncherAction | undefined,
    callerId: string,
  ): LearningReceipt | undefined {
    // The latest explicit execution supersedes an earlier pending choice even
    // when it is itself ineligible (preview, provider or context operation).
    const previous = this.learningExecutions.get(callerId);
    if (previous) {
      previous.cancelled = true;
      this.learningExecutions.delete(callerId);
    }
    if (
      !session?.learningKeyword ||
      !action ||
      !this.preferences.learningEnabled ||
      this.options.getContext?.(callerId) ||
      action.activation.context ||
      !this.current(session)
    )
      return;
    const target = this.actionTarget(action);
    if (!target || (target.kind === "command" && !action.learnable)) return;
    const receipt: LearningReceipt = {
      sessionId: session.sessionId,
      requestId: session.requestId,
      keyword: session.learningKeyword,
      target,
      action,
      revision: this.preferences.learningRevision,
      cancelled: false,
      closedByExecution: false,
    };
    this.learningExecutions.set(callerId, receipt);
    return receipt;
  }
  private finishLearning(
    receipt: LearningReceipt | undefined,
    callerId: string,
    owner: PluginOwner,
    result: JsonValue | undefined,
  ): void {
    if (
      !receipt ||
      receipt.cancelled ||
      this.learningExecutions.get(callerId) !== receipt ||
      !this.preferences.learningEnabled ||
      receipt.revision !== this.preferences.learningRevision ||
      this.options.getContext?.(callerId) ||
      !this.available(receipt.action) ||
      !this.options.manager()?.isOwnerCurrent(owner, receipt.action.activation.commandId)
    )
      return;
    const session = this.sessions.get(callerId);
    if (
      !(session?.sessionId === receipt.sessionId && session.requestId === receipt.requestId) &&
      !receipt.closedByExecution
    )
      return;
    const negative =
      result === false ||
      (result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        (result.ok === false ||
          result.cancelled === true ||
          result.canceled === true ||
          ["cancelled", "canceled", "closed"].includes(String(result.status ?? ""))));
    if (
      negative ||
      (receipt.target.kind === "command"
        ? this.hidden(receipt.target)
        : this.hidden(this.commandTarget(receipt.target.pluginId, "search")))
    )
      return;
    try {
      this.preferences.learn(receipt.keyword, receipt.target);
      // A successful execution may still be returning a workspace result. Only
      // notify the count; requerying here could invalidate that legitimate reply.
      this.notifyLearning();
    } catch {
      console.warn("launcher-keyword-learning-write-failed");
    }
  }
  private rankApplications(
    session: LauncherSession,
    query: string,
    items: LauncherItem[],
  ): LauncherItem[] {
    if (!session.learningKeyword) return items;
    const aliases = new Set(
      this.preferences
        .entries()
        .filter(
          (entry) =>
            entry.target.kind === "application" &&
            entry.aliases.some(
              (alias) => normalizeLearningKeyword(alias) === session.learningKeyword,
            ),
        )
        .map((entry) => launcherTargetKey(entry.target)),
    );
    return items
      .map((item, index) => ({
        item,
        index,
        exact:
          normalizeLearningKeyword(item.title) === normalizeLearningKeyword(query) ||
          !!(item.preference && aliases.has(item.preference.key)),
      }))
      .sort(
        (a, b) =>
          Number(b.exact) - Number(a.exact) ||
          Number(!!b.item.learned) - Number(!!a.item.learned) ||
          a.index - b.index,
      )
      .map(({ item }) => item);
  }
  enterMode(value: unknown, callerId = "internal"): void {
    const { mode } = z.strictObject({ mode: z.string().max(170) }).parse(value);
    const entry = this.commands(true, callerId).find(
      ({ pluginId, command }) => command.mode && `${pluginId}:${command.mode}` === mode,
    );
    if (!entry) throw new Error("Plugin mode is unavailable");
    this.remember(entry.pluginId, entry.command.id);
  }
  clear(
    callerId?: string,
    sessionId?: string,
    requestId?: string,
    reason: "cancel" | "execution" = "cancel",
  ): void {
    // These receipts outlive their own successful UI handoff, but remain
    // revocable even after its query session has already been deleted.
    for (const [key, receipt] of this.learningExecutions) {
      if (callerId !== undefined && key !== callerId) continue;
      if (sessionId !== undefined && receipt.sessionId !== sessionId) continue;
      if (requestId !== undefined && receipt.requestId !== requestId) continue;
      if (reason === "execution") receipt.closedByExecution = true;
      else {
        receipt.cancelled = true;
        this.learningExecutions.delete(key);
      }
    }
    for (const [key, session] of this.sessions) {
      if (callerId !== undefined && key !== callerId) continue;
      if (sessionId !== undefined && session.sessionId !== sessionId) continue;
      if (requestId !== undefined && session.requestId !== requestId) continue;
      session.controller.abort();
      session.actions.clear();
      this.sessions.delete(key);
    }
  }
  queryIdentity(callerId: string): { sessionId: string; requestId: string } | undefined {
    const session = this.sessions.get(callerId);
    return session ? { sessionId: session.sessionId, requestId: session.requestId } : undefined;
  }
  invalidateApplicationAvailability(): void {
    this.applicationAvailability.clear();
  }
  private installation(pluginId: string): string | undefined {
    const record = this.options
      .manager()
      ?.list()
      .find((value) => value.pluginId === pluginId);
    return record?.enabled && !record.lastError
      ? JSON.stringify([record.version, record.integrity, record.manifestDigest])
      : undefined;
  }
  private available(action: LauncherAction): boolean {
    const manager = this.options.manager();
    return (
      !!manager &&
      !!action.installation &&
      action.installation === this.installation(action.pluginId) &&
      action.sourceApplication ===
        this.options.getContext?.(action.callerId)?.context.sourceApplication &&
      this.commandSourceAllowed(action.pluginId, action.activation.commandId, action.callerId) &&
      (action.contextRevision === undefined ||
        action.contextRevision === (this.options.getContextRevision?.(action.callerId) ?? 0)) &&
      (action.owner
        ? this.ownerCurrent(action.owner, action.activation.commandId)
        : this.publicCommands().some(
            (entry) =>
              entry.pluginId === action.pluginId &&
              entry.command.id === action.activation.commandId,
          ))
    );
  }
  private current(session: LauncherSession): boolean {
    return (
      this.sessions.get(session.callerId) === session &&
      !session.controller.signal.aborted &&
      (session.contextRevision === undefined ||
        session.contextRevision === this.options.getContextRevision?.(session.callerId)) &&
      session.sourceApplication ===
        this.options.getContext?.(session.callerId)?.context.sourceApplication
    );
  }
  private bindOwner(action: LauncherAction): void {
    if (action.owner) return;
    const record = this.options
      .manager()
      ?.list()
      .find((value) => value.pluginId === action.pluginId);
    if (
      record?.status === "active" &&
      record.instanceId &&
      action.installation === this.installation(action.pluginId)
    )
      action.owner = {
        pluginId: record.pluginId,
        version: record.version,
        instanceId: record.instanceId,
      };
  }
  private snapshot(session: LauncherSession): LauncherQueryResult {
    return this.withCatalog(() => this.readSnapshot(session));
  }
  private readSnapshot(session: LauncherSession): LauncherQueryResult {
    const groups = session.groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const action = session.actions.get(item.id);
        return item.unavailable || (!!action && this.available(action));
      }),
    }));
    return {
      sessionId: session.sessionId,
      requestId: session.requestId,
      revision: session.revision,
      pending: groups.some((group) => group.status === "pending"),
      groups,
      items: groups.flatMap((group) => group.items),
      ...(session.hint ? { hint: session.hint } : {}),
    };
  }
  private publish(session: LauncherSession): void {
    if (!this.current(session) || !session.streaming) return;
    session.revision++;
    this.options.onQueryUpdate?.(session.callerId, this.snapshot(session));
  }
  /** Registry notifications also include cold starts and update checks. Only
   * actual availability/identity changes revoke the affected query groups. */
  pluginsChanged(): void {
    if (!this.sessions.size) return;
    this.withCatalog(() => this.refreshPlugins());
  }
  private refreshPlugins(): void {
    for (const session of this.sessions.values()) {
      let changed = false;
      for (const [id, action] of session.actions) {
        this.bindOwner(action);
        if (!this.available(action)) {
          session.actions.delete(id);
          changed = true;
        }
      }
      for (const [id, provider] of session.providers) {
        const available =
          provider.installation === this.installation(provider.pluginId) &&
          this.publicCommands().some(
            (entry) =>
              entry.pluginId === provider.pluginId && entry.command.id === provider.commandId,
          ) &&
          this.commandSourceAllowed(provider.pluginId, provider.commandId, session.callerId);
        if (available) continue;
        provider.controller.abort();
        const group = provider.group ?? session.groups.find((group) => group.id === id)!;
        if (group.status !== "error" || group.items.length) {
          group.status = "error";
          group.items =
            group.id === "pinned"
              ? group.items.filter(
                  (item) => item.pluginId !== provider.pluginId || item.unavailable,
                )
              : [];
          group.hint = this.options.getLocale?.().startsWith("en")
            ? "Plugin unavailable"
            : "插件已停用或不可用";
          changed = true;
        }
      }
      if (changed) this.publish(session);
    }
  }
  private item(
    session: LauncherSession,
    action: LauncherAction,
    title: string,
    description?: string,
    kind?: string,
    presentation?: Pick<z.infer<typeof pageSchema>["items"][number], "actions" | "icon">,
  ): LauncherItem {
    const id = randomUUID();
    action = {
      ...action,
      callerId: session.callerId,
      sourceApplication: session.sourceApplication,
      presentation: { title, description },
      installation: action.installation ?? this.installation(action.pluginId),
      activation: {
        ...action.activation,
        context:
          action.activation.context ??
          this.providerContext(session.callerId, action.pluginId, action.activation.commandId),
      },
    };
    if (action.activation.context || action.sourceApplication) {
      action.contextRevision = this.options.getContextRevision?.(session.callerId) ?? 0;
      action.callerId = session.callerId;
    }
    this.bindOwner(action);
    session.actions.set(id, action);
    const target = this.actionTarget(action);
    const learned = this.learningChoice(session);
    if (target?.kind === "application" && this.preferences.find(launcherTargetKey(target)))
      this.applicationAvailability.set(launcherTargetKey(target), {
        installation: action.installation,
        found: true,
      });
    return {
      id,
      pluginId: action.pluginId,
      commandId: action.activation.commandId,
      title,
      description,
      kind,
      ...(target &&
      learned &&
      (target.kind === "application" || action.learnable) &&
      launcherTargetKey(target) === launcherTargetKey(learned)
        ? { learned: true }
        : {}),
      ...(target ? { preference: this.preferenceEntry(target, title, description, true) } : {}),
      ...(presentation?.icon ? { icon: presentation.icon } : {}),
      ...(presentation?.actions?.length
        ? {
            actions: presentation.actions
              .filter(
                (command) =>
                  !this.commandHidden(action.pluginId, command.commandId) &&
                  this.commandSourceAllowed(action.pluginId, command.commandId, session.callerId),
              )
              .map((command) => {
                const id = randomUUID();
                session.actions.set(id, {
                  pluginId: action.pluginId,
                  installation: action.installation,
                  owner: action.owner,
                  callerId: action.callerId,
                  contextRevision: action.contextRevision,
                  sourceApplication: action.sourceApplication,
                  activation: {
                    commandId: command.commandId,
                    parameters: command.parameters as JsonValue | undefined,
                    context: this.providerContext(
                      session.callerId,
                      action.pluginId,
                      command.commandId,
                    ),
                  },
                });
                return { id, title: command.title, commandId: command.commandId };
              }),
          }
        : {}),
    };
  }
  private pageItems(
    session: LauncherSession,
    pluginId: string,
    owner: PluginOwner,
    page: z.infer<typeof pageSchema>,
    installation?: string,
  ): LauncherItem[] {
    return this.withCatalog(() =>
      page.items
        .filter(
          (item) =>
            !this.commandHidden(pluginId, item.commandId) &&
            this.commandSourceAllowed(pluginId, item.commandId, session.callerId),
        )
        .map((item) =>
          this.item(
            session,
            {
              pluginId,
              owner,
              installation,
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
    );
  }
  query(value: unknown, callerId = "internal"): Promise<LauncherQueryResult> {
    return this.withCatalog(() => this.startQuery(value, callerId));
  }
  private async startQuery(value: unknown, callerId: string): Promise<LauncherQueryResult> {
    const { query, mode, sessionId, directory } = querySchema.parse(value);
    this.clear(callerId);
    const session: LauncherSession = {
      callerId,
      sessionId,
      requestId: randomUUID(),
      revision: 0,
      controller: new AbortController(),
      actions: new Map(),
      groups: [],
      providers: new Map(),
      streaming: true,
      sourceApplication: this.options.getContext?.(callerId)?.context.sourceApplication,
      contextRevision: this.options.getContextRevision?.(callerId),
    };
    this.sessions.set(callerId, session);
    const manager = this.options.manager();
    if (!manager) return { ...this.snapshot(session), hint: "插件正在准备，请稍后重试" };
    const commands = this.commands(!!mode, callerId);
    const installations = new Map(
      commands.map((entry) => [entry.pluginId, this.installation(entry.pluginId)]),
    );
    const locale = this.options.getLocale?.() ?? "zh-CN";
    const inputContext = this.options.getContext?.(callerId)?.context;
    if (!directory && !inputContext && !mode)
      session.learningKeyword = normalizeLearningKeyword(query);
    if (mode) {
      const entry = commands.find(
        ({ pluginId, command }) => command.mode && `${pluginId}:${command.mode}` === mode,
      );
      if (!entry) return { ...this.snapshot(session), hint: "此模式所属插件已停用或不可用" };
      if (
        !directory &&
        !inputContext &&
        entry.pluginId === "spark233.applications" &&
        entry.command.id === "search"
      )
        session.learningKeyword = normalizeLearningKeyword(query);
      const modeApplicationIds = this.applicationIds(query, false, session.learningKeyword);
      session.groups = [
        {
          id: mode,
          title: entry.command.title,
          pluginId: entry.pluginId,
          status: "pending",
          items: [],
        },
      ];
      const controller = new AbortController();
      session.providers.set(mode, {
        pluginId: entry.pluginId,
        commandId: entry.command.id,
        installation: this.installation(entry.pluginId),
        controller,
        group: session.groups[0],
      });
      const { value, owner } = await manager.queryOwned(
        entry.pluginId,
        {
          commandId: entry.command.id,
          context: this.providerContext(callerId, entry.pluginId, entry.command.id),
          parameters: {
            action: "search",
            query,
            mode: entry.command.mode!,
            limit:
              entry.pluginId === "spark233.applications"
                ? Math.min(100, Math.max(60, modeApplicationIds.length + 12))
                : entry.pluginId === "spark233.translation"
                  ? 5 // Keep dictionary suggestions compact and within its provider budget.
                  : 60,
            callerId,
            requestId: session.requestId,
            locale,
            ...(entry.pluginId === "spark233.applications" && modeApplicationIds.length
              ? { includeIds: modeApplicationIds }
              : {}),
            ...(directory ? { directory } : {}),
          },
        },
        AbortSignal.any([session.controller.signal, controller.signal]),
        () => {
          if (
            !this.current(session) ||
            !this.commandSourceAllowed(entry.pluginId, entry.command.id, callerId)
          )
            throw new Error("来源程序已变化，请重新查询");
        },
      );
      if (!this.current(session)) return { sessionId, items: [] };
      const page = pageSchema.parse(value);
      session.groups = [
        {
          id: mode,
          title: entry.command.title,
          pluginId: entry.pluginId,
          status: "ready",
          hint: page.hint,
          instructions: page.instructions,
          items:
            entry.pluginId === "spark233.applications"
              ? this.rankApplications(
                  session,
                  query,
                  this.pageItems(session, entry.pluginId, owner, page),
                )
              : this.pageItems(session, entry.pluginId, owner, page),
        },
      ];
      session.hint = page.hint;
      return this.snapshot(session);
    }
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
    const savedEntries = this.preferences.entries();
    const pinned = !needle
      ? savedEntries.filter(
          (entry) =>
            entry.pinned &&
            !entry.hidden &&
            (entry.target.kind !== "command" ||
              !pluginManagedCommands[entry.target.pluginId]?.includes(entry.target.commandId)) &&
            (entry.target.kind !== "command" ||
              this.commandSourceAllowed(entry.target.pluginId, entry.target.commandId, callerId)),
        )
      : [];
    const pinnedKeys = new Set(pinned.map((entry) => launcherTargetKey(entry.target)));
    const applicationIds = this.applicationIds(query, !needle, session.learningKeyword);
    const wordsByCommand = commands.map(({ command, sourceTitle }) =>
      [command.title, sourceTitle, ...command.keywords, ...command.aliases].map((word) =>
        word.normalize("NFKC").toLocaleLowerCase(),
      ),
    );
    const commandsGroup: LauncherResultGroup = {
      id: "commands",
      title: locale.startsWith("en") ? "Actions" : "操作",
      status: "ready",
      items: [],
    };
    session.groups.push(commandsGroup);
    const commandItems = new Map<string, LauncherItem>();
    const applicationItems = new Map<string, LauncherItem>();
    const pinnedGroup: LauncherResultGroup | undefined = pinned.length
      ? {
          id: "pinned",
          title: locale.startsWith("en") ? "Pinned" : "固定入口",
          status: "ready",
          items: [],
        }
      : undefined;
    if (pinnedGroup) session.groups.unshift(pinnedGroup);
    const refreshPins = () => {
      if (!pinnedGroup) return;
      pinnedGroup.items = pinned.map((entry) => {
        const key = launcherTargetKey(entry.target);
        const candidate =
          entry.target.kind === "command"
            ? commandItems.get(JSON.stringify([entry.target.pluginId, entry.target.commandId]))
            : applicationItems.get(key);
        const item = candidate?.preference?.key === key ? candidate : undefined;
        return (
          item ?? {
            id: `unavailable:${key}`,
            pluginId: entry.target.pluginId,
            title: entry.title,
            description: locale.startsWith("en")
              ? "Unavailable · Manage entries to remove or restore"
              : "入口不可用 · 可在入口管理中移除或恢复",
            unavailable: true,
            preference: this.preferenceEntry(entry.target, entry.title, entry.description, false),
          }
        );
      });
    };
    const rankCommands = (pinyin = new Map<number, number>()) =>
      this.withCatalog(() => {
        const sentenceInput =
          !!needle && (!localWord.test(query.trim()) || query.trim().split(/\s+/u).length > 4);
        commandsGroup.items = commands
          .map((entry, index) => {
            const words = wordsByCommand[index];
            const literal = !needle
              ? 1
              : words.some((word) => word === needle)
                ? 100
                : words.some((word) => word.startsWith(needle))
                  ? 75
                  : words.some((word) => word.includes(needle))
                    ? 40
                    : 0;
            const score = Math.max(literal, pinyin.get(index) ?? 0);
            const matches = (context: PluginContext) =>
              !entry.command.match ||
              (entry.command.match === "word"
                ? context.kind === "text" && localWord.test(context.text.trim())
                : entry.command.match === "text"
                  ? context.kind === "text" && !!context.text.trim()
                  : context.kind === entry.command.match);
            const textInput =
              !!needle &&
              entry.command.inputs.includes("text") &&
              matches({ kind: "text", text: query });
            const adaptedContext =
              inputContext &&
              (this.options.adaptContext
                ? this.options.adaptContext(
                    callerId,
                    entry.pluginId,
                    entry.command.id,
                    inputContext,
                  )
                : inputContext);
            const enrichedContext =
              adaptedContext &&
              (inputContext?.sourceApplication
                ? { ...adaptedContext, sourceApplication: inputContext.sourceApplication }
                : adaptedContext);
            const commandContext =
              this.providerContext(callerId, entry.pluginId, entry.command.id, enrichedContext) ??
              enrichedContext;
            const contextInput =
              !!commandContext &&
              entry.command.inputs.includes(commandContext.kind) &&
              matches(commandContext);
            const usage = !needle
              ? this.preferences.usage.find(
                  (value) =>
                    value.pluginId === entry.pluginId && value.commandId === entry.command.id,
                )
              : undefined;
            return {
              ...entry,
              score: contextInput
                ? Math.max(110, score)
                : textInput &&
                    sentenceInput &&
                    entry.pluginId === "spark233.translation" &&
                    entry.command.id === "translate"
                  ? Math.max(90, score)
                  : score || (textInput ? 10 : 0),
              textInput,
              contextInput,
              commandContext,
              usage,
              learned:
                !!session.learningKeyword &&
                !textInput &&
                !contextInput &&
                !entry.command.inputs.length &&
                !entry.command.search &&
                !entry.command.mode &&
                (() => {
                  const target = this.commandTarget(entry.pluginId, entry.command.id);
                  const learned = this.learningChoice(session);
                  return (
                    !!target &&
                    !!learned &&
                    launcherTargetKey(target) === launcherTargetKey(learned)
                  );
                })(),
            };
          })
          .filter((entry) => {
            if (!entry.score) return false;
            const { pluginId, command } = entry;
            if (
              pluginManagedCommands[pluginId]?.includes(command.id) &&
              !(
                pluginId === "spark233.translation" &&
                command.id === "translate" &&
                (entry.contextInput || entry.textInput)
              )
            )
              return false;
            if (needle || inputContext) return true;
            const target = this.commandTarget(pluginId, command.id);
            if (!!target && pinnedKeys.has(launcherTargetKey(target))) return true;
            // A pinned keyword-only entry still shows; an unpinned one waits for
            // the user to type, so the empty launcher stays free of entries that
            // only re-enter the same search box.
            if (pluginKeywordOnlyCommands[pluginId]?.includes(command.id)) return false;
            return (
              !Object.hasOwn(pluginEntryCommands, pluginId) ||
              pluginEntryCommands[pluginId] === command.id ||
              !!pluginActionCommands[pluginId]?.includes(command.id) ||
              (pluginId === "spark233.notes" && command.id === "new")
            );
          })
          .sort((a, b) =>
            !needle && (!inputContext || inputContext.kind === "window")
              ? Number(b.contextInput || !!b.command.sourceApplications) -
                  Number(a.contextInput || !!a.command.sourceApplications) ||
                (b.usage?.lastUsedAt ?? 0) - (a.usage?.lastUsedAt ?? 0) ||
                (b.usage?.count ?? 0) - (a.usage?.count ?? 0)
              : b.score - a.score || Number(b.learned) - Number(a.learned),
          )
          .filter(
            (entry, index) =>
              index < (needle ? 40 : 40 + pinned.length) ||
              (!needle &&
                pinnedKeys.has(
                  launcherTargetKey(this.commandTarget(entry.pluginId, entry.command.id)!),
                )),
          )
          .map(({ pluginId, command, textInput, contextInput, commandContext, usage }) => {
            const key = JSON.stringify([pluginId, command.id]);
            let item = commandItems.get(key);
            if (!item) {
              item = {
                ...this.item(
                  session,
                  {
                    pluginId,
                    installation: installations.get(pluginId),
                    learnable:
                      !textInput &&
                      !contextInput &&
                      !command.inputs.length &&
                      !command.search &&
                      !command.mode,
                    activation: {
                      commandId: command.id,
                      ...(contextInput
                        ? { context: commandContext }
                        : textInput
                          ? {
                              context: {
                                kind: "text",
                                text: query,
                                ...(inputContext?.sourceApplication
                                  ? { sourceApplication: inputContext.sourceApplication }
                                  : {}),
                              },
                            }
                          : {}),
                    },
                  },
                  command.title,
                  command.description,
                  "command",
                ),
                ...(usage ? { usage: { count: usage.count, lastUsedAt: usage.lastUsedAt } } : {}),
              };
              commandItems.set(key, item);
            }
            return item;
          })
          .filter((item) => !pinnedKeys.has(item.preference?.key ?? ""))
          .slice(0, 40);
        refreshPins();
      });
    rankCommands();
    // Commands are usable before either native pinyin or local providers finish.
    if (needle && this.options.commandMatcher) {
      commandsGroup.status = "pending";
      session.matching = new AbortController();
      void this.options.commandMatcher
        .score(
          wordsByCommand,
          needle,
          AbortSignal.any([session.controller.signal, session.matching.signal]),
        )
        .then(
          (scores) => {
            if (!this.current(session) || !session.streaming) return;
            rankCommands(scores);
            commandsGroup.status = "ready";
            this.publish(session);
          },
          (error: unknown) => {
            if (!this.current(session) || !session.streaming) return;
            commandsGroup.status = "error";
            commandsGroup.hint = String(error);
            this.publish(session);
          },
        )
        .catch((error) => {
          if (!this.current(session)) return;
          commandsGroup.status = "error";
          commandsGroup.hint = String(error);
          this.publish(session);
        });
    }
    for (const entry of commands.filter(
      ({ command, pluginId }) =>
        (needle ||
          (pluginId === "spark233.applications" &&
            command.id === "search" &&
            applicationIds.length)) &&
        (command.search === "default" || (command.search === "word" && localWord.test(needle))),
    )) {
      const id = JSON.stringify([entry.pluginId, entry.command.id]);
      const resolvingPins = !needle && entry.pluginId === "spark233.applications" && !!pinnedGroup;
      const group: LauncherResultGroup = resolvingPins
        ? pinnedGroup!
        : {
            id,
            pluginId: entry.pluginId,
            title: entry.command.title,
            status: "pending",
            items: [],
          };
      const provider = {
        pluginId: entry.pluginId,
        commandId: entry.command.id,
        installation: this.installation(entry.pluginId),
        controller: new AbortController(),
        group,
      };
      group.status = "pending";
      if (!resolvingPins) session.groups.push(group);
      session.providers.set(id, provider);
      const providerLimit = resolvingPins
        ? 100
        : entry.pluginId === "spark233.applications" && applicationIds.length
          ? Math.min(100, Math.max(12, applicationIds.length + 12))
          : entry.pluginId === "spark233.translation"
            ? 5
            : 12;
      void manager
        .queryOwned(
          entry.pluginId,
          {
            commandId: entry.command.id,
            context: this.providerContext(callerId, entry.pluginId, entry.command.id),
            parameters: {
              action: "search",
              query,
              limit: providerLimit,
              callerId,
              requestId: session.requestId,
              locale,
              ...(entry.pluginId === "spark233.applications" &&
              entry.command.id === "search" &&
              applicationIds.length
                ? { includeIds: applicationIds, ...(resolvingPins ? { onlyIds: true } : {}) }
                : {}),
            },
          },
          AbortSignal.any([session.controller.signal, provider.controller.signal]),
          () => {
            if (
              !this.current(session) ||
              !this.commandSourceAllowed(entry.pluginId, entry.command.id, callerId)
            )
              throw new Error("来源程序已变化，请重新查询");
          },
        )
        .then(({ value, owner }) => {
          if (
            !this.current(session) ||
            !this.commandSourceAllowed(entry.pluginId, entry.command.id, callerId) ||
            !session.streaming ||
            provider.controller.signal.aborted ||
            provider.installation !== this.installation(entry.pluginId) ||
            !manager.isOwnerCurrent(owner, entry.command.id)
          )
            return;
          const page = pageSchema.parse(value);
          const items = this.pageItems(session, entry.pluginId, owner, page, provider.installation);
          if (entry.pluginId === "spark233.applications" && entry.command.id === "search") {
            for (const applicationId of applicationIds) {
              const target: LauncherPreferenceTarget = {
                kind: "application",
                packageName: "@spark233/plugin-applications",
                pluginId: "spark233.applications",
                applicationId,
              };
              const key = launcherTargetKey(target);
              const item = items.find((item) => item.preference?.key === key);
              if (
                this.preferences.find(key) &&
                (item || resolvingPins || page.items.length < providerLimit)
              )
                this.applicationAvailability.set(key, {
                  installation: provider.installation,
                  found: !!item,
                });
              if (item) applicationItems.set(key, item);
            }
          }
          if (resolvingPins) refreshPins();
          else
            group.items =
              entry.pluginId === "spark233.applications"
                ? this.rankApplications(session, query, items)
                : items;
          group.status = "ready";
          group.hint = resolvingPins ? undefined : page.hint;
          group.instructions = page.instructions;
          this.publish(session);
        })
        .catch((error: unknown) => {
          if (!this.current(session) || !session.streaming || provider.controller.signal.aborted)
            return;
          group.status = "error";
          group.hint = String(error);
          this.publish(session);
        });
    }
    return this.snapshot(session);
  }
  async execute(value: unknown, callerId = "internal"): Promise<JsonValue | undefined> {
    const input = executeSchema.parse(value);
    const manager = this.options.manager();
    if (!manager) throw new Error("插件宿主尚未就绪");
    let session = this.sessions.get(callerId);
    const action = input.id ? session?.actions.get(input.id) : undefined;
    if (
      input.id &&
      (!action ||
        !this.available(action) ||
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
    if (!this.commandSourceAllowed(input.pluginId, input.commandId, callerId))
      throw new Error("此命令不适用于当前来源程序");
    const selected: LauncherAction = action ?? {
      pluginId: input.pluginId,
      callerId,
      sourceApplication: this.options.getContext?.(callerId)?.context.sourceApplication,
      contextRevision: this.options.getContext?.(callerId)
        ? this.options.getContextRevision?.(callerId)
        : undefined,
      activation: {
        commandId: command!.command.id,
        context: this.providerContext(callerId, input.pluginId, command!.command.id),
      },
    };
    if (
      selected.owner &&
      ["spark233.search", "spark233.applications"].includes(selected.pluginId)
    ) {
      const parameters = selected.activation.parameters;
      if (parameters && typeof parameters === "object" && !Array.isArray(parameters))
        selected.activation = { ...selected.activation, parameters: { ...parameters, callerId } };
    }
    if (!session) {
      session = {
        callerId,
        sessionId: randomUUID(),
        requestId: randomUUID(),
        revision: 0,
        controller: new AbortController(),
        actions: new Map(),
        groups: [],
        providers: new Map(),
        streaming: false,
        sourceApplication: this.options.getContext?.(callerId)?.context.sourceApplication,
        contextRevision: this.options.getContextRevision?.(callerId),
      };
      this.sessions.set(callerId, session);
    }
    const receipt = this.beginLearning(session, action, callerId);
    session.streaming = false;
    session.matching?.abort();
    for (const [id, provider] of session.providers)
      if ((provider.group ?? session.groups.find((group) => group.id === id))?.status === "pending")
        provider.controller.abort();
    if (selected.activation.commandId === "next-page")
      for (const [id, action] of session.actions)
        if (action.pluginId === selected.pluginId && action.activation.commandId === "next-page")
          session.actions.delete(id);
    try {
      const execution = await manager.activateOwned(selected.pluginId, selected.activation, () => {
        if (
          selected.sourceApplication !==
            this.options.getContext?.(callerId)?.context.sourceApplication ||
          (selected.contextRevision !== undefined &&
            selected.contextRevision !== this.options.getContextRevision?.(callerId)) ||
          !this.commandSourceAllowed(selected.pluginId, selected.activation.commandId, callerId)
        )
          throw new Error("来源程序已变化，请重新选择动作");
      });
      const result = execution.value;
      if (selected.activation.commandId)
        this.remember(selected.pluginId, selected.activation.commandId);
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        Array.isArray(result.items)
      ) {
        if (
          !session ||
          !this.current(session) ||
          (selected.owner && !manager.isOwnerCurrent(selected.owner, selected.activation.commandId))
        )
          return;
        const page = pageSchema.parse(result);
        const owner = execution.owner;
        if (!owner || !manager.isOwnerCurrent(owner, selected.activation.commandId)) return;
        const items = this.pageItems(session, selected.pluginId, owner, page);
        return JSON.parse(
          JSON.stringify({
            launcherResults: { sessionId: randomUUID(), items, hint: page.hint },
            append: selected.activation.commandId === "next-page",
            pagePluginId: selected.pluginId,
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
        if (!this.current(session) || (action && !this.available(action))) return;
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
      this.finishLearning(receipt, callerId, execution.owner, result);
      return result;
    } finally {
      if (receipt && this.learningExecutions.get(callerId) === receipt)
        this.learningExecutions.delete(callerId);
    }
  }
}
