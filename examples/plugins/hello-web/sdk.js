/** A browser-only client: no Electron/Node imports or arbitrary IPC channel access. */
export function createPluginClient(bridge) {
    bridge ??= globalThis.spark233;
    if (!bridge)
        throw new Error("spark233 plugin preload is unavailable");
    const transport = bridge;
    let active = true;
    let current;
    const queued = [];
    const activations = new Map();
    const themes = new Set();
    const saves = new Set();
    const commands = new Map();
    const queries = new Map();
    const pendingQueries = new Map();
    const queryWaiters = new Map();
    const request = (operation, payload) => {
        if (!active)
            return Promise.reject(new Error("Plugin browser client was released"));
        return transport.request(operation, payload);
    };
    const matches = (owner) => !!current &&
        owner.pluginId === current.owner.pluginId &&
        owner.version === current.owner.version &&
        owner.instanceId === current.owner.instanceId;
    const deliver = (handler) => {
        if (!active ||
            !current?.activation ||
            !current.activationId ||
            activations.get(handler) === current.activationId)
            return;
        activations.set(handler, current.activationId);
        handler(current.activation);
    };
    const receive = (event) => {
        if (!active)
            return;
        if (!current) {
            queued.push(event);
            return;
        }
        if (!matches(event.owner))
            return;
        if (event.type === "activation") {
            current.activation = event.activation;
            current.activationId = event.activationId;
            for (const handler of activations.keys())
                deliver(handler);
        }
        else if (event.type === "theme") {
            current.theme = event.theme;
            for (const handler of themes)
                handler(event.theme);
        }
        else if (event.type === "query-cancel") {
            pendingQueries.get(event.requestId)?.abort();
            pendingQueries.delete(event.requestId);
        }
        else if (event.type === "query") {
            const controller = new AbortController();
            pendingQueries.set(event.requestId, controller);
            void (async () => {
                let result;
                try {
                    const id = event.activation.commandId;
                    if (id && !queries.has(id))
                        await new Promise((resolve) => {
                            const waiting = queryWaiters.get(id) ?? new Set();
                            const finish = () => {
                                clearTimeout(timer);
                                waiting.delete(finish);
                                if (!waiting.size)
                                    queryWaiters.delete(id);
                                controller.signal.removeEventListener("abort", finish);
                                resolve(undefined);
                            };
                            const timer = setTimeout(finish, 250);
                            waiting.add(finish);
                            queryWaiters.set(id, waiting);
                            controller.signal.addEventListener("abort", finish, { once: true });
                            if (controller.signal.aborted)
                                finish();
                        });
                    controller.signal.throwIfAborted();
                    const handler = id ? queries.get(id) : undefined;
                    if (!handler)
                        throw new Error("Plugin query handler is not registered");
                    result = { value: await handler(event.activation, controller.signal) };
                }
                catch (error) {
                    result = {
                        error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
                    };
                }
                if (active && !controller.signal.aborted)
                    await request("query.result", {
                        requestId: event.requestId,
                        ...result,
                    }).catch(() => request("query.result", {
                        requestId: event.requestId,
                        error: "Plugin query result is invalid or exceeds the payload limit",
                    }));
            })()
                .catch(() => { })
                .finally(() => {
                if (pendingQueries.get(event.requestId) === controller)
                    pendingQueries.delete(event.requestId);
            });
        }
        else {
            void (async () => {
                let decision = { ok: true };
                try {
                    for (const handler of saves) {
                        decision = await handler(event.reason);
                        if (!decision.ok)
                            break;
                    }
                }
                catch (error) {
                    decision = { ok: false, reason: error instanceof Error ? error.message : String(error) };
                }
                if (!decision.ok)
                    decision = { ok: false, reason: String(decision.reason).slice(0, 1000) };
                if (active)
                    await request("lifecycle.result", { requestId: event.requestId, decision });
            })().catch(() => { }); // A released host fences late save acknowledgements.
        }
    };
    const unsubscribe = transport.subscribe(receive);
    const ready = request("context.get").then((value) => {
        if (!active)
            throw new Error("Plugin browser client was released");
        current = value;
        if (!current?.owner?.instanceId)
            throw new Error("Invalid plugin session context");
        for (const event of queued.splice(0))
            receive(event);
        return current;
    });
    const onActivation = (handler) => {
        activations.set(handler, undefined);
        void ready
            .then(() => {
            if (activations.has(handler))
                deliver(handler);
        })
            .catch(() => { });
        return () => {
            activations.delete(handler);
        };
    };
    onActivation((activation) => {
        const handler = activation.commandId ? commands.get(activation.commandId) : undefined;
        if (handler)
            void Promise.resolve(handler(activation)).catch(() => { });
    });
    return {
        context: async () => {
            await ready;
            return structuredClone(current);
        },
        storage: {
            get: (key) => request("storage.get", { key }),
            set: async (key, value) => {
                await request("storage.set", { key, value });
            },
            remove: async (key) => {
                await request("storage.remove", { key });
            },
        },
        registerCommand: async (id, handler) => {
            await ready;
            await request("command.register", { id });
            commands.set(id, handler);
            if (current?.activation?.commandId === id)
                await handler(current.activation);
            return () => {
                if (commands.get(id) === handler)
                    commands.delete(id);
            };
        },
        registerQuery: async (id, handler) => {
            queries.set(id, handler);
            for (const notify of [...(queryWaiters.get(id) ?? [])])
                notify();
            try {
                await ready;
                await request("command.register", { id });
            }
            catch (error) {
                if (queries.get(id) === handler)
                    queries.delete(id);
                throw error;
            }
            return () => {
                if (queries.get(id) === handler)
                    queries.delete(id);
            };
        },
        onActivation,
        onTheme: (handler) => {
            themes.add(handler);
            return () => {
                themes.delete(handler);
            };
        },
        onPrepareStop: (handler) => {
            saves.add(handler);
            return () => {
                saves.delete(handler);
            };
        },
        capability: (capability, operation, payload) => request("capability.invoke", {
            capability,
            operation,
            ...(payload === undefined ? {} : { payload }),
        }),
        close: async () => {
            await request("window.close");
        },
        dispose: () => {
            active = false;
            unsubscribe();
            queued.length = 0;
            activations.clear();
            themes.clear();
            saves.clear();
            commands.clear();
            queries.clear();
            for (const controller of pendingQueries.values())
                controller.abort();
            pendingQueries.clear();
        },
    };
}
