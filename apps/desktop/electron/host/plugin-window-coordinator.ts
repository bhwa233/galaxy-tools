import { randomUUID } from "node:crypto";
import {
  windowBindingSchema,
  type WindowBinding,
  type WindowEnvironment,
  type PluginActivation,
} from "@spark233/sdk";
import { AppError } from "../persistence.js";
import { supersedePresentation } from "./presentation-epoch.js";
import { cancelWindowTasks, windowOpenContext } from "./plugin-window-routing.js";
import type { ResolvedWindowDefinition } from "./plugin-window-catalog.js";
import {
  PluginWindowLayoutStore,
  type PluginWindowLayout,
  type WindowInstanceRecord,
  type WindowPlacementRecord,
} from "./plugin-window-state.js";

export interface PluginWindowAdapter {
  /** Called only for a persisted new creation intent; never during restore. */
  create?(definition: ResolvedWindowDefinition, creationId: string): Promise<WindowBinding>;
  restore(instance: WindowInstanceRecord, placement: WindowPlacementRecord): Promise<void>;
  activate?(instance: WindowInstanceRecord, activation: PluginActivation): Promise<void>;
  prepareClose(instance: WindowInstanceRecord): Promise<{ ok: boolean; reason?: string }>;
  closePlacement(
    instance: WindowInstanceRecord,
    placement: WindowPlacementRecord,
    remaining: readonly WindowPlacementRecord[],
  ): Promise<void>;
}
export interface WindowOpenRequest {
  pluginId: string;
  windowId: string;
  /** Supplied by a trusted host caller, never copied from a page payload. */
  environment: WindowEnvironment;
  action: "open" | "create" | "restore";
  binding?: WindowBinding;
  instanceId?: string;
  /** Trusted host intent UUID. Reuse it when retrying a failed add-panel action. */
  creationId?: string;
  bounds?: WindowPlacementRecord["bounds"];
  activation?: PluginActivation;
  assertActive?: () => void;
}

/** Reuses the atomic store and existing per-owner adapters. A plugin-local queue
 * serializes identity decisions across creation, save and cleanup; the runtime
 * owner and presentation epoch remain the adapter's separate responsibility. */
export class PluginWindowCoordinator {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly options: {
      store: PluginWindowLayoutStore;
      definition(pluginId: string, windowId: string): ResolvedWindowDefinition | undefined;
      adapter(definition: ResolvedWindowDefinition): PluginWindowAdapter;
      blocked?: () => boolean;
      unavailable?: (pluginId: string) => boolean;
    },
  ) {}

  private serial<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.queues.set(pluginId, next);
    void next
      .finally(() => {
        if (this.queues.get(pluginId) === next) this.queues.delete(pluginId);
      })
      .catch(() => {});
    return next;
  }

  private definition(pluginId: string, windowId: string, environment: WindowEnvironment) {
    const definition = this.options.definition(pluginId, windowId);
    if (!definition) throw new AppError("window.notDeclared", "插件未声明此窗口");
    if (definition.purpose !== "business")
      throw new AppError("window.dialog", "临时对话框不能建立长期展示记录");
    if (environment === "card-desktop" && !definition.cardDesktop)
      throw new AppError("cardDesktopUnsupported", "此窗口未声明支持卡片桌面");
    return definition;
  }

  open(request: WindowOpenRequest): Promise<WindowPlacementRecord> {
    if (this.options.blocked?.())
      return Promise.reject(new AppError("maintenance", "窗口管理正在维护"));
    try {
      request.assertActive?.();
      this.definition(request.pluginId, request.windowId, request.environment);
      if (this.options.unavailable?.(request.pluginId))
        throw new AppError("pluginDisabled", "插件已停用或存在错误");
      if (request.binding && request.binding.windowId !== request.windowId)
        throw new AppError("window.bindingMismatch", "内容绑定不属于目标窗口");
    } catch (error) {
      return Promise.reject(error);
    }
    const state = this.options.store.load();
    const existing = this.findInstance(
      state,
      request,
      this.definition(request.pluginId, request.windowId, request.environment),
    );
    const placement = state.placements.find(
      (value) => value.instanceId === existing?.id && value.environment === request.environment,
    );
    const assertActive = request.assertActive;
    const queued = {
      ...request,
      assertActive: () => {
        assertActive?.();
        const current = this.options.store.load();
        if (
          (existing && !current.instances.some((value) => value.id === existing.id)) ||
          (placement && !current.placements.some((value) => value.id === placement.id))
        )
          throw new AppError("cancelled", "窗口展示已关闭");
      },
    };
    return this.serial(request.pluginId, () => this.openSerial(queued));
  }

  private findInstance(
    state: PluginWindowLayout,
    request: WindowOpenRequest,
    definition: ResolvedWindowDefinition,
  ) {
    const candidates = state.instances.filter(
      (instance) =>
        instance.pluginId === request.pluginId &&
        (instance.binding.windowId === request.windowId ||
          (request.pluginId === "spark233.notes" &&
            ["tile", "notepad"].includes(instance.binding.windowId) &&
            ["tile", "notepad"].includes(request.windowId))) &&
        (request.creationId === instance.id ||
          request.instanceId === instance.id ||
          definition.reuse !== "document" ||
          (!!request.binding?.contentId &&
            instance.binding.contentId === request.binding.contentId)),
    );
    return request.creationId
      ? (candidates.find((value) => value.id === request.creationId) ??
          (definition.reuse === "singleton" ? candidates[0] : undefined))
      : request.instanceId
        ? candidates.find((value) => value.id === request.instanceId)
        : request.action === "create" && definition.reuse !== "singleton"
          ? undefined
          : (candidates.find((value) =>
              state.placements.some(
                (placement) =>
                  placement.instanceId === value.id &&
                  placement.environment === request.environment,
              ),
            ) ?? (definition.reuse === "multiple" ? undefined : candidates[0]));
  }

  private async openSerial(request: WindowOpenRequest): Promise<WindowPlacementRecord> {
    request.assertActive?.();
    if (this.options.blocked?.()) throw new AppError("maintenance", "窗口管理正在维护");
    const definition = this.definition(request.pluginId, request.windowId, request.environment);
    if (this.options.unavailable?.(request.pluginId) === true)
      throw new AppError("pluginDisabled", "插件已停用或存在错误");
    if (request.binding && request.binding.windowId !== request.windowId)
      throw new AppError("window.bindingMismatch", "内容绑定不属于目标窗口");
    const adapter = this.options.adapter(definition);
    const state = this.options.store.load();
    if (
      request.creationId &&
      state.instances.some(
        (value) =>
          value.id === request.creationId &&
          (value.pluginId !== request.pluginId || value.binding.windowId !== request.windowId),
      )
    )
      throw new AppError("window.bindingMismatch", "创建意图不属于目标窗口");
    let instance = this.findInstance(state, request, definition);
    if (request.action === "restore" && !instance)
      throw new AppError("window.restoreMissing", "找不到已有窗口实例，不能通过恢复创建内容");
    if (request.instanceId && !instance)
      throw new AppError("window.restoreMissing", "找不到目标窗口实例");
    if (
      instance &&
      request.binding?.contentId &&
      instance.binding.contentId !== request.binding.contentId
    )
      throw new AppError("window.bindingMismatch", "内容绑定不属于目标实例");
    if (!instance) {
      if (request.binding && request.binding.windowId !== definition.windowId)
        throw new AppError("window.bindingMismatch", "内容绑定不属于目标窗口");
      if (
        request.action === "open" &&
        definition.create &&
        !request.binding?.contentId &&
        definition.reuse === "document"
      )
        throw new AppError("window.contentRequired", "打开已有内容需要稳定内容标识");
      if (
        definition.reuse === "document" &&
        !request.binding?.contentId &&
        request.action !== "create"
      )
        throw new AppError("window.contentRequired", "打开已有内容需要稳定内容标识");
      const creationId = request.creationId ?? randomUUID();
      const pending = state.pendingCreates.find((value) => value.id === creationId);
      if (
        pending &&
        (pending.pluginId !== request.pluginId ||
          pending.windowId !== request.windowId ||
          pending.environment !== request.environment)
      )
        throw new AppError("window.bindingMismatch", "创建意图不属于目标窗口");
      if (pending && !pending.binding && request.pluginId !== "spark233.notes")
        throw new AppError(
          "window.creationUnconfirmed",
          "无法确认创建结果，请先检查插件中的内容，避免重复新建",
        );
      const bounds = pending?.bounds ?? request.bounds ?? { x: 24, y: 110, ...definition.size };
      if (!pending)
        this.options.store.commit((draft) =>
          draft.pendingCreates.push({
            id: creationId,
            pluginId: request.pluginId,
            windowId: request.windowId,
            environment: request.environment,
            bounds,
            ...(request.binding ? { binding: windowBindingSchema.parse(request.binding) } : {}),
          }),
        );
      // On an unknown result leave this intent intact. Never issue a replacement
      // creation ID on restore or automatically repeat a non-idempotent command.
      const binding = windowBindingSchema.parse(
        pending?.binding ??
          request.binding ??
          (definition.create
            ? await adapter.create?.(definition, creationId)
            : {
                windowId: definition.windowId,
                parameterVersion: definition.restore?.parameterVersion ?? 1,
              }),
      );
      request.assertActive?.();
      if (this.options.blocked?.()) throw new AppError("maintenance", "窗口管理正在维护");
      if (
        binding.windowId !== definition.windowId ||
        (definition.reuse === "document" && !binding.contentId)
      )
        throw new AppError("window.bindingMismatch", "创建结果缺少正确的窗口或内容标识");
      this.options.store.commit((draft) => {
        draft.pendingCreates.find((value) => value.id === creationId)!.binding = binding;
      });
      instance = {
        id: creationId,
        pluginId: request.pluginId,
        binding,
        autoRestore: definition.restore?.autoOpen ?? false,
      };
      const created = instance;
      this.options.store.commit((draft) => {
        draft.instances.push(created);
        draft.pendingCreates = draft.pendingCreates.filter((value) => value.id !== creationId);
        draft.placements.push(this.placement(created.id, request.environment, bounds));
      });
    }
    let placement = this.options.store
      .load()
      .placements.find(
        (value) => value.instanceId === instance.id && value.environment === request.environment,
      );
    if (!placement) {
      placement = this.placement(
        instance.id,
        request.environment,
        request.bounds ?? { x: 24, y: 110, ...definition.size },
      );
      const added = placement;
      this.options.store.commit((draft) => draft.placements.push(added));
    } else if (!placement.visible) {
      const id = placement.id;
      this.options.store.commit((draft) => {
        draft.placements.find((value) => value.id === id)!.visible = true;
      });
      placement = { ...placement, visible: true };
    }
    request.assertActive?.();
    if (this.options.blocked?.()) throw new AppError("maintenance", "窗口管理正在维护");
    const assertActive = () => {
      request.assertActive?.();
      if (!this.options.store.load().placements.some((value) => value.id === placement.id))
        throw new AppError("cancelled", "窗口展示已关闭");
    };
    await windowOpenContext.run(
      {
        environment: request.environment,
        coordinated: true,
        instanceId: instance.id,
        assertActive,
      },
      () => adapter.restore(instance, placement),
    );
    assertActive();
    if (this.options.blocked?.()) throw new AppError("maintenance", "窗口管理正在维护");
    if (request.activation)
      await windowOpenContext.run(
        {
          environment: request.environment,
          coordinated: true,
          instanceId: instance.id,
          assertActive,
        },
        () => adapter.activate?.(instance, request.activation!) ?? Promise.resolve(),
      );
    return placement;
  }

  private placement(
    instanceId: string,
    environment: WindowEnvironment,
    bounds: WindowPlacementRecord["bounds"],
  ): WindowPlacementRecord {
    return {
      id: randomUUID(),
      instanceId,
      environment,
      bounds,
      visible: true,
      order: Date.now(),
      ...(environment === "desktop" ? { topmost: false } : {}),
    };
  }

  async close(placementId: string): Promise<void> {
    supersedePresentation();
    const state = this.options.store.load();
    const placement = state.placements.find((value) => value.id === placementId);
    const instance = state.instances.find((value) => value.id === placement?.instanceId);
    if (!placement || !instance) return Promise.resolve();
    const definition = this.options.definition(instance.pluginId, instance.binding.windowId);
    if (!definition) {
      this.options.store.commit((draft) => {
        draft.placements = draft.placements.filter((value) => value.id !== placementId);
        if (!draft.placements.some((value) => value.instanceId === instance.id))
          draft.instances = draft.instances.filter((value) => value.id !== instance.id);
      });
      return;
    }
    const adapter = this.options.adapter(definition);
    const remaining = this.options.store
      .commit((draft) => {
        draft.placements = draft.placements.filter((value) => value.id !== placementId);
        if (!draft.placements.some((value) => value.instanceId === instance.id))
          draft.instances = draft.instances.filter((value) => value.id !== instance.id);
      })
      .placements.filter((value) => value.instanceId === instance.id);
    if (!remaining.length) cancelWindowTasks(instance.id);
    await adapter.closePlacement(instance, placement, remaining);
  }
  refresh(placementId: string): Promise<void> {
    const state = this.options.store.load();
    const placement = state.placements.find((value) => value.id === placementId);
    const instance = state.instances.find((value) => value.id === placement?.instanceId);
    if (!placement || !instance) return Promise.resolve();
    return this.serial(instance.pluginId, async () => {
      const definition = this.definition(
        instance.pluginId,
        instance.binding.windowId,
        placement.environment,
      );
      await windowOpenContext.run(
        { environment: placement.environment, coordinated: true, instanceId: instance.id },
        () => this.options.adapter(definition).restore(instance, placement),
      );
    });
  }
  /** Save intent before the external mutation; only confirmed commits clear displays. */
  beginCleanup(pluginId: string, contentId?: string): string {
    if (this.options.blocked?.()) throw new AppError("maintenance", "窗口管理正在维护");
    const id = randomUUID();
    this.options.store.commit((draft) => {
      draft.cleanup.push({
        id,
        pluginId,
        contentId,
        confirmed: false,
        instanceIds: draft.instances
          .filter(
            (value) =>
              value.pluginId === pluginId && (!contentId || value.binding.contentId === contentId),
          )
          .map((value) => value.id),
        creationIds: draft.pendingCreates
          .filter(
            (value) =>
              value.pluginId === pluginId && (!contentId || value.binding?.contentId === contentId),
          )
          .map((value) => value.id),
      });
    });
    return id;
  }
  cancelCleanup(id: string): void {
    this.options.store.commit((draft) => {
      draft.cleanup = draft.cleanup.filter((value) => value.id !== id);
    });
  }
  confirmCleanup(id: string): void {
    this.options.store.commit((draft) => {
      const intent = draft.cleanup.find((value) => value.id === id);
      if (intent) intent.confirmed = true;
    });
    this.replayCleanup();
  }
  replayCleanup(): void {
    if (!this.options.store.load().cleanup.some((value) => value.confirmed)) return;
    this.options.store.commit((draft) => {
      const confirmed = draft.cleanup.filter((value) => value.confirmed);
      const removed = new Set(
        draft.instances
          .filter((instance) =>
            confirmed.some(
              (value) =>
                value.pluginId === instance.pluginId &&
                (!value.instanceIds || value.instanceIds.includes(instance.id)) &&
                (!value.contentId || value.contentId === instance.binding.contentId),
            ),
          )
          .map((value) => value.id),
      );
      draft.placements = draft.placements.filter((value) => !removed.has(value.instanceId));
      draft.instances = draft.instances.filter((value) => !removed.has(value.id));
      draft.pendingCreates = draft.pendingCreates.filter(
        (value) =>
          !confirmed.some(
            (item) =>
              item.pluginId === value.pluginId &&
              (!item.creationIds || item.creationIds.includes(value.id)) &&
              (!item.contentId || item.contentId === value.binding?.contentId),
          ),
      );
      draft.cleanup = draft.cleanup.filter((value) => !value.confirmed);
    });
  }
  /** Run only after the authoritative plugin/business stores have recovered,
   * before accepting new mutations. Unknown outcomes remain durable. */
  async reconcileCleanup(
    outcome: (
      intent: PluginWindowLayout["cleanup"][number],
    ) => Promise<"removed" | "retained" | "unknown">,
  ): Promise<void> {
    this.replayCleanup();
    // Older records predate target snapshots. Freeze their current targets before
    // awaiting any external query, so a later owner cannot join an old cleanup.
    if (this.options.store.load().cleanup.some((value) => !value.instanceIds || !value.creationIds))
      this.options.store.commit((draft) => {
        for (const intent of draft.cleanup) {
          intent.instanceIds ??= draft.instances
            .filter(
              (value) =>
                value.pluginId === intent.pluginId &&
                (!intent.contentId || value.binding.contentId === intent.contentId),
            )
            .map((value) => value.id);
          intent.creationIds ??= draft.pendingCreates
            .filter(
              (value) =>
                value.pluginId === intent.pluginId &&
                (!intent.contentId || value.binding?.contentId === intent.contentId),
            )
            .map((value) => value.id);
        }
      });
    for (const intent of this.options.store.load().cleanup) {
      await this.serial(intent.pluginId, async () => {
        if (!this.options.store.load().cleanup.some((value) => value.id === intent.id)) return;
        const result = await outcome(intent);
        if (result === "removed") this.confirmCleanup(intent.id);
        else if (result === "retained") this.cancelCleanup(intent.id);
      }).catch((error) => console.error("window-cleanup-recovery", intent.id, error));
    }
  }
  async resumeCreates(creationId?: string): Promise<void> {
    const intents = this.options.store
      .load()
      .pendingCreates.filter((value) => !creationId || value.id === creationId);
    if (creationId && !intents.length)
      throw new AppError("window.restoreMissing", "创建记录已不存在");
    for (const intent of intents) {
      await this.serial(intent.pluginId, async () => {
        if (this.options.blocked?.() || this.options.unavailable?.(intent.pluginId)) {
          if (creationId) throw new AppError("window.unavailable", "插件当前不可恢复，请稍后重试");
          return;
        }
        if (!this.options.store.load().pendingCreates.some((value) => value.id === intent.id))
          return;
        const definition = this.definition(intent.pluginId, intent.windowId, intent.environment);
        const adapter = this.options.adapter(definition);
        // Notes' creation receipt is persisted with the business index. Unknown
        // third-party results require explicit resolution, never blind replay.
        const binding =
          intent.binding ??
          (intent.pluginId === "spark233.notes" && adapter.create
            ? await adapter.create(definition, intent.id)
            : undefined);
        if (!binding) {
          if (creationId)
            throw new AppError(
              "window.creationUnconfirmed",
              "无法确认创建结果，请先检查插件中的内容，避免重复新建",
            );
          return;
        }
        if (this.options.blocked?.() || this.options.unavailable?.(intent.pluginId)) {
          if (creationId) throw new AppError("window.unavailable", "插件当前不可恢复，请稍后重试");
          return;
        }
        const checked = windowBindingSchema.parse(binding);
        if (checked.windowId !== intent.windowId)
          throw new AppError("window.bindingMismatch", "创建回执不属于目标窗口");
        if (definition.reuse === "document" && !checked.contentId)
          throw new AppError("window.bindingMismatch", "恢复创建回执缺少稳定内容标识");
        const instance = {
          id: intent.id,
          pluginId: intent.pluginId,
          binding: checked,
          autoRestore: definition.restore?.autoOpen ?? false,
        };
        const placement = this.placement(instance.id, intent.environment, intent.bounds);
        this.options.store.commit((draft) => {
          draft.instances.push(instance);
          draft.placements.push(placement);
          draft.pendingCreates = draft.pendingCreates.filter((value) => value.id !== intent.id);
        });
        if (creationId)
          await windowOpenContext.run(
            { environment: intent.environment, coordinated: true, instanceId: instance.id },
            () => adapter.restore(instance, placement),
          );
      }).catch((error) => {
        if (creationId) throw error;
        console.error("window-create-recovery", intent.id, error);
      });
    }
  }
  async drain(): Promise<void> {
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
  }
}
