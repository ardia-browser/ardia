"use strict";
(() => {
  var PLUGIN_PROTOCOL = 2;
  var HOST_METHODS = {
    hello: "hello",
    ready: "ready",
    result: "result",
    values: "values",
    subscribe: "subscribe",
    windows: "windows",
    run: "run",
    open: "open",
    toolsCall: "tools.call",
    activePage: "tabs.readActivePage",
    workspace: "workspace",
    workspaceApply: "apply",
    quickPick: "ui.showQuickPick",
    inputBox: "ui.showInputBox",
    confirm: "ui.showConfirm",
    toast: "ui.showToast",
    toolbarUpdate: "toolbar.update",
    panelOpen: "panel.open",
    panelClose: "panel.close",
    storageGet: "storage.get",
    storageSet: "storage.set",
    storageDelete: "storage.delete",
    storageKeys: "storage.keys",
    secretGet: "secrets.get",
    secretSet: "secrets.set",
    secretDelete: "secrets.delete",
    pageOpen: "page.open",
    pagePost: "page.post",
    fetch: "net.fetch",
    programsStatus: "programs.status",
    programsRelink: "programs.relink",
    surfaceRender: "surface.render",
    surfaceClose: "surface.close",
    credentialsVerb: "credentials.verb",
    credentialsVerbCancel: "credentials.verb.cancel",
    credentialsSignInCancel: "credentials.signIn.cancel",
    credentialsTakeStored: "credentials.session.takeStored",
    credentialsDropStored: "credentials.session.dropStored",
    credentialsValuesSet: "credentials.values.set",
    credentialsOwnerConfirm: "credentials.owner.confirm"
  };
  function isSurfaceMessage(value) {
    if (typeof value !== "object" || value === null) return false;
    const surface = value.surface;
    return (surface === "mount" || surface === "unmount" || surface === "event") && typeof value.surfaceId === "string";
  }

  var PluginError = class extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "PluginError";
      this.code = code;
    }
  };
  function errorMessage(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }
  var LocalEncodingError = class extends PluginError {
  };
  function isUnencodable(error) {
    return error instanceof LocalEncodingError;
  }
  function replyError(error) {
    if (typeof error === "string") return new PluginError("failed", error);
    const code = typeof error?.code === "string" ? error.code : "failed";
    const message = typeof error?.message === "string" ? error.message : "The host refused the request.";
    return new PluginError(code, message);
  }
  function createRpc(transport) {
    const waiting = new Map();
    let next = 0;
    let closedBy = null;
    const send = (message) => transport.send(JSON.stringify(message));
    return {
      send,
      request(method, params = {}) {
        if (closedBy) return Promise.reject(closedBy);
        const id = ++next;
        let line;
        try {
          line = JSON.stringify({ id, method, params });
        } catch (error) {
          return Promise.reject(new LocalEncodingError("unencodable", `The ${method} request couldn't be encoded: ${errorMessage(error)}`));
        }
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          try {
            transport.send(line);
          } catch (error) {
            waiting.delete(id);
            reject(error);
          }
        });
      },
      takeReply(message) {
        if (typeof message.method === "string" || !("id" in message)) return false;
        if (!("result" in message) && !("error" in message)) return false;
        const id = message.id;
        const waiter = typeof id === "number" ? waiting.get(id) : void 0;
        if (!waiter) return true;
        waiting.delete(id);
        const reply = message;
        if (reply.error !== void 0 && reply.error !== null) waiter.reject(replyError(reply.error));
        else waiter.resolve(reply.result);
        return true;
      },
      pendingCount: () => waiting.size,
      close(reason) {
        if (closedBy) return;
        closedBy = reason;
        const waiters = [...waiting.values()];
        waiting.clear();
        for (const waiter of waiters) waiter.reject(reason);
      }
    };
  }

  function createRegistry() {
    return {
      commands: new Map(),
      tools: new Map(),
      views: new Map(),
      omnibox: new Set(),
      decide: new Map(),
      events: new Map(),
      pages: new Set(),
      settings: new Set()
    };
  }
  function disposable(dispose) {
    let done = false;
    return {
      dispose() {
        if (done) return;
        done = true;
        dispose();
      }
    };
  }
  function registerIn(map, key, value, label) {
    if (map.has(key)) throw new Error(`${label} ${String(key)} is already registered.`);
    map.set(key, value);
    return disposable(() => {
      if (map.get(key) === value) map.delete(key);
    });
  }
  function addTo(set, value) {
    set.add(value);
    return disposable(() => set.delete(value));
  }

  function unwrap(result, key) {
    if (typeof result === "object" && result !== null && !Array.isArray(result) && key in result) return result[key];
    return result;
  }
  function pickedIds(result) {
    const picked = unwrap(result, "picked");
    if (typeof picked === "string") return [picked];
    if (Array.isArray(picked)) return picked.filter((id) => typeof id === "string");
    return [];
  }
  function response(reply) {
    if (typeof reply.status !== "number") {
      const reason = reply.reason;
      throw new PluginError("failed", typeof reason === "string" && reason ? reason : "The fetch failed.");
    }
    const data = reply;
    return {
      ...data,
      ok: data.status >= 200 && data.status < 300,
      text: () => data.body,
      json: () => JSON.parse(data.body)
    };
  }
  function quickPick(rpc) {
    async function pick(items, options = {}) {
      const sent = { ...options };
      const sentItems = items.map((item) => ({ ...item }));
      const result = await rpc.request(HOST_METHODS.quickPick, { items: sentItems, options: sent });
      if (result === null || result === void 0) return void 0;
      const ids = pickedIds(result);
      const chosen = sentItems.filter((item) => ids.includes(item.id));
      return sent.canPickMany ? chosen : chosen[0];
    }
    return pick;
  }
  function createArdia(rpc, registry, state) {
    const settings = {
      get(key, fallback) {
        return key in state.values ? state.values[key] : fallback;
      },
      all: () => ({ ...state.values }),
      onChange: (listener) => addTo(registry.settings, listener),
      async refresh() {
        const values = await rpc.request(HOST_METHODS.values);
        state.values = { ...values ?? {} };
        return { ...state.values };
      }
    };
    const hooks = {
      decide: (name, handler) => registerIn(registry.decide, name, handler, "Decide hook"),
      on(event, listener) {
        let listeners = registry.events.get(event);
        if (!listeners) registry.events.set(event, listeners = new Set());
        const added = addTo(listeners, listener);
        state.subscriptionsChanged();
        return {
          dispose() {
            added.dispose();
            if (listeners.size === 0 && registry.events.get(event) === listeners) registry.events.delete(event);
            state.subscriptionsChanged();
          }
        };
      }
    };
    const apply = (ops) => rpc.request(HOST_METHODS.workspaceApply, { ops });
    const windows = async () => {
      const listed = await rpc.request(HOST_METHODS.windows);
      return (listed ?? []).map((w) => ({ ...w, tabs: w.tabs.map((t) => ({ ...t, windowId: w.id })) }));
    };
    return {
      get plugin() {
        return { ...state.info };
      },
      commands: {
        register: (name, handler) => registerIn(registry.commands, name, handler, "Command"),
        run: (command, options = {}) => rpc.request(HOST_METHODS.run, {
          command,
          ...options.arg !== void 0 ? { arg: options.arg } : {},
          ...options.windowId !== void 0 ? { window: options.windowId } : {},
          ...options.tabId !== void 0 ? { tab: options.tabId } : {}
        })
      },
      views: {
        register: (viewId, component) => registerIn(registry.views, viewId, component, "View")
      },
      omnibox: {
        register: (provider) => addTo(registry.omnibox, provider)
      },
      tools: {
        register: (name, handler) => registerIn(registry.tools, name, handler, "Tool"),
        call: (plugin, tool, input) => rpc.request(HOST_METHODS.toolsCall, { plugin, tool, input })
      },
      hooks,
      tabs: {
        windows,
        async query(filter = {}) {
          const all = (await windows()).flatMap((w) => w.tabs);
          return all.filter(
            (t) => (filter.active === void 0 || t.active === filter.active) && (filter.pinned === void 0 || t.pinned === filter.pinned) && (filter.windowId === void 0 || t.windowId === filter.windowId)
          );
        },
        activePage: async () => await rpc.request(HOST_METHODS.activePage) ?? null,
        open: (urls, options = {}) => rpc.request(HOST_METHODS.open, { urls: typeof urls === "string" ? [urls] : urls, ...options }),
        close: (tabId) => apply([{ op: "tab.close", tabs: [tabId] }]),
        activate: (tabId) => apply([{ op: "tab.activate", tab: tabId }])
      },
      workspace: {
        snapshot: (options = {}) => rpc.request(HOST_METHODS.workspace, { ...options }),
        apply
      },
      ui: {
        quickPick: quickPick(rpc),
        async inputBox(options) {
          const value = unwrap(await rpc.request(HOST_METHODS.inputBox, { options }), "value");
          return typeof value === "string" ? value : void 0;
        },
        async confirm(options) {
          return unwrap(await rpc.request(HOST_METHODS.confirm, { options }), "confirmed") === true;
        },
        toast: (title, message, options = {}) => rpc.request(HOST_METHODS.toast, { title, ...message ? { message } : {}, options }).then(() => void 0)
      },
      toolbar: {
        update: (itemId, update) => rpc.request(HOST_METHODS.toolbarUpdate, { itemId, update }).then(() => void 0)
      },
      panels: {
        open: (panelId) => rpc.request(HOST_METHODS.panelOpen, { panelId }),
        close: (panelId) => rpc.request(HOST_METHODS.panelClose, { panelId })
      },
      storage: {
        get: async (key) => {
          const res = await rpc.request(HOST_METHODS.storageGet, { key });
          return res && typeof res === "object" && res.found === true ? res.value : void 0;
        },
        set: (key, value) => rpc.request(HOST_METHODS.storageSet, { key, value }).then(() => void 0),
        delete: (key) => rpc.request(HOST_METHODS.storageDelete, { key }).then(() => void 0),
        keys: async () => {
          const keys = unwrap(await rpc.request(HOST_METHODS.storageKeys), "keys");
          return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
        }
      },
      secrets: {
        get: async (key) => {
          const value = unwrap(await rpc.request(HOST_METHODS.secretGet, { key }), "value");
          return typeof value === "string" ? value : void 0;
        },
        set: (key, value) => rpc.request(HOST_METHODS.secretSet, { key, value }).then(() => void 0),
        delete: (key) => rpc.request(HOST_METHODS.secretDelete, { key }).then(() => void 0)
      },
      settings,
      pages: {
        open: (options = {}) => rpc.request(HOST_METHODS.pageOpen, options),
        post: (view, message) => rpc.request(HOST_METHODS.pagePost, { view, message }).then(() => void 0),
        onMessage: (listener) => addTo(registry.pages, listener)
      },
      programs: {
        status: () => rpc.request(HOST_METHODS.programsStatus),
        relink: () => rpc.request(HOST_METHODS.programsRelink)
      },
      net: {
        async fetch(input, init = {}) {
          const request = typeof input === "string" ? { ...init, url: input } : { ...input, ...init };
          return response(await rpc.request(HOST_METHODS.fetch, request));
        }
      }
    };
  }

  var ELEMENT = Symbol.for("ardia.plugin.element");
  function isVNode(value) {
    return typeof value === "object" && value !== null && value.$$typeof === ELEMENT;
  }
  function element(type, props, key) {
    const given = props ?? {};
    let ownKey = key ?? null;
    let rest = given;
    if ("key" in given) {
      const { key: propKey, ...others } = given;
      if (ownKey === null && propKey !== void 0 && propKey !== null) ownKey = propKey;
      rest = others;
    }
    return { $$typeof: ELEMENT, type, key: ownKey, props: rest };
  }
  function jsx(type, props, key) {
    return element(type, props, key);
  }
  var jsxs = jsx;
  function hostComponent(type) {
    const render = (props) => element(type, props, void 0);
    return Object.assign(render, { hostType: type });
  }
  function hostTypeOf(type) {
    if (typeof type === "string") return type;
    const host = typeof type === "function" ? type.hostType : void 0;
    return typeof host === "string" ? host : null;
  }
  function providerOf(type) {
    const id = typeof type === "function" ? type.providerOf : void 0;
    return typeof id === "symbol" ? id : null;
  }
  function consumerOf(type) {
    const id = typeof type === "function" ? type.consumerOf : void 0;
    return typeof id === "symbol" ? id : null;
  }
  function createContext(defaultValue) {
    const id = Symbol("ardia.plugin.context");
    const Provider = Object.assign((props) => props.children, { providerOf: id });
    const Consumer = Object.assign((props) => props.children(defaultValue), { consumerOf: id });
    return { id, defaultValue, Provider, Consumer };
  }

  function newFiber(type, path, scheduler) {
    return { type, path, scheduler, hooks: [], children: new Map(), seen: new Set(), context: new Map(), alive: true };
  }
  function depsChanged(previous, next) {
    if (previous === void 0 || next === void 0) return true;
    if (previous.length !== next.length) return true;
    for (let i = 0; i < next.length; i++) if (!Object.is(previous[i], next[i])) return true;
    return false;
  }
  function unmountFiber(fiber) {
    if (!fiber.alive) return;
    fiber.alive = false;
    for (const hook of fiber.hooks) {
      if (hook.kind !== "effect") continue;
      const cleanup = hook.cleanup;
      hook.cleanup = void 0;
      hook.next = void 0;
      if (!cleanup) continue;
      try {
        cleanup();
      } catch (error) {
        fiber.scheduler.report(error);
      }
    }
    for (const child of fiber.children.values()) unmountFiber(child);
    fiber.children.clear();
  }

  var current = null;
  var cursor = 0;
  function beginHooks(fiber) {
    current = fiber;
    cursor = 0;
  }
  function endHooks() {
    current = null;
    cursor = 0;
  }
  function claimHook(kind, make) {
    const fiber = current;
    if (!fiber) throw new Error("Hooks only work inside a component while it renders.");
    const at = cursor++;
    const existing = fiber.hooks[at];
    if (existing) {
      if (existing.kind !== kind) throw new Error(`Hook ${at} changed from ${existing.kind} to ${kind}; call hooks in the same order on every render.`);
      return [existing, fiber];
    }
    const made = make(fiber);
    fiber.hooks[at] = made;
    return [made, fiber];
  }
  function stateHook(fiber, initial, reduce) {
    const hook = {
      kind: "state",
      value: initial,
      set: (action) => {
        if (!fiber.alive) return;
        const next = reduce(hook.value, action);
        if (Object.is(next, hook.value)) return;
        hook.value = next;
        fiber.scheduler.schedule();
      }
    };
    return hook;
  }
  var applyAction = (previous, action) => typeof action === "function" ? action(previous) : action;
  function useState(initial) {
    const [hook] = claimHook("state", (fiber) => stateHook(fiber, typeof initial === "function" ? initial() : initial, applyAction));
    return [hook.value, hook.set];
  }
  function useEffect(effect, deps) {
    const [hook, fiber] = claimHook("effect", () => ({ kind: "effect", deps: void 0, cleanup: void 0, next: void 0 }));
    if (hook.deps !== void 0 && !depsChanged(hook.deps, deps)) return;
    hook.deps = deps;
    hook.next = effect;
    fiber.scheduler.queueEffect(fiber, hook);
  }
  function useMemo(factory, deps) {
    const [hook] = claimHook("memo", () => ({ kind: "memo", deps: void 0, value: void 0, ready: false }));
    if (!hook.ready || depsChanged(hook.deps, deps)) {
      hook.value = factory();
      hook.deps = deps;
      hook.ready = true;
    }
    return hook.value;
  }
  function useContext(context) {
    const fiber = current;
    if (!fiber) throw new Error("useContext only works inside a component while it renders.");
    return fiber.context.has(context.id) ? fiber.context.get(context.id) : context.defaultValue;
  }

  var nativeMicrotask = globalThis.queueMicrotask;
  var enqueueMicrotask = typeof nativeMicrotask === "function" ? (task) => nativeMicrotask(task) : (task) => void Promise.resolve().then(task);
  var EMPTY_CONTEXT = new Map();
  var fiberKeys = new WeakMap();
  var fiberSerials = new WeakMap();
  var lastFiberSerial = 0;
  var lastSurfaceSerial = 0;
  function serialOf(fiber) {
    let serial = fiberSerials.get(fiber);
    if (serial === void 0) fiberSerials.set(fiber, serial = ++lastFiberSerial);
    return serial;
  }
  function isPlainObject(value) {
    if (typeof value !== "object" || value === null) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  var isThenable = (value) => typeof value === "object" && value !== null && typeof value.then === "function";
  function describe(value) {
    if (typeof value === "function") return `a function (${value.name || "anonymous"})`;
    if (typeof value === "symbol") return "a symbol";
    if (typeof value === "object" && value !== null) return `an object with keys ${Object.keys(value).join(", ") || "none"}`;
    return typeof value;
  }
  function errorNode(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      type: "EmptyState",
      props: { icon: "exclamationmark.triangle", title: "This view hit an error", description: message, tone: "destructive" },
      children: []
    };
  }
  function asTree(nodes) {
    if (nodes.length === 1 && typeof nodes[0] === "object") return nodes[0];
    return { type: "Fragment", props: {}, children: nodes };
  }
  var Surface = class {
    tree = null;
    root;
    handlers = new Map();
    handlerIds = new Map();
    passHandlers = new Map();
    passPaths = new Set();
    nextHandler = 0;
    handlerPrefix = `h${++lastSurfaceSerial}.`;
    effects = [];
    passCreated = [];
    passRemoved = [];
    passRendered = [];
    scheduled = false;
    rendering = false;
    dead = false;
    chained = 0;
    cycling = false;
    exhausted = false;
    element;
    props;
    onCommit;
    options;
    constructor(element2, props, onCommit, options) {
      this.element = element2;
      this.props = props;
      this.onCommit = onCommit;
      this.options = options;
      this.root = newFiber("root", "", this);
    }
    schedule() {
      if (this.dead || this.exhausted) return;
      if (!this.cycling) this.chained = 0;
      if (this.scheduled) return;
      this.scheduled = true;
      enqueueMicrotask(() => {
        if (!this.scheduled) return;
        this.scheduled = false;
        this.render();
      });
    }
    queueEffect(fiber, hook) {
      this.effects.push({ fiber, hook });
    }
    report(error) {
      if (this.options.onError) this.options.onError(error);
      else globalThis.console?.error?.(error);
    }
    update(props) {
      this.props = props;
      this.schedule();
    }
    flush() {
      if (!this.scheduled || this.rendering) return;
      this.scheduled = false;
      this.render();
    }
    hasHandler(handlerId) {
      return this.handlers.has(handlerId);
    }
    dispatch(handlerId, args = []) {
      if (this.dead) throw new Error("This view is closed.");
      const handler = this.handlers.get(handlerId);
      if (!handler) throw new Error(`There's no handler ${handlerId}; the view re-rendered without it.`);
      return handler(...args);
    }
    unmount() {
      if (this.dead) return;
      this.dead = true;
      this.scheduled = false;
      this.effects = [];
      unmountFiber(this.root);
      this.handlers.clear();
      this.handlerIds.clear();
    }
    render() {
      if (this.dead) return;
      if (this.rendering) return this.schedule();
      const limit = this.options.maxRenders ?? 50;
      this.rendering = true;
      this.cycling = true;
      this.chained++;
      this.exhausted = this.chained > limit;
      try {
        const tree = this.renderPass(limit);
        if (this.dead) return;
        this.tree = tree;
        try {
          this.onCommit(tree, this.handlers);
        } catch (error) {
          this.report(error);
        }
        this.runEffects();
      } finally {
        this.exhausted = false;
        this.rendering = false;
        this.cycling = false;
      }
    }
    renderPass(limit) {
      this.passHandlers = new Map();
      this.passPaths = new Set();
      this.passCreated = [];
      this.passRemoved = [];
      this.passRendered = [];
      try {
        if (this.exhausted) throw new Error(`The view re-rendered ${limit} times in a row; a state update is looping.`);
        const top = typeof this.element === "function" ? jsx(this.element, this.props) : this.element;
        this.root.seen.clear();
        const nodes = this.renderValue(this.root, "r", top, EMPTY_CONTEXT, null);
        this.sweep(this.root);
        const removed = this.passRemoved;
        this.passRemoved = [];
        for (const { fiber } of removed) unmountFiber(fiber);
        if (this.dead) return errorNode(new Error("This view is closed."));
        this.handlers = this.passHandlers;
        for (const path of [...this.handlerIds.keys()]) if (!this.passPaths.has(path)) this.handlerIds.delete(path);
        return asTree(nodes);
      } catch (error) {
        endHooks();
        this.abandonPass();
        this.handlers = new Map();
        this.report(error);
        return errorNode(error);
      } finally {
        this.passCreated = [];
        this.passRemoved = [];
        this.passRendered = [];
      }
    }
    abandonPass() {
      for (const { hook } of this.effects) hook.next = void 0;
      this.effects = [];
      for (const { fiber, hookCount, effectDeps } of this.passRendered) {
        fiber.hooks.length = Math.min(fiber.hooks.length, hookCount);
        for (const [hook, deps] of effectDeps) {
          hook.deps = deps;
          hook.next = void 0;
        }
      }
      for (const { parent, slot, fiber } of this.passCreated.reverse()) {
        if (parent.children.get(slot) === fiber) parent.children.delete(slot);
        unmountFiber(fiber);
      }
      for (const { parent, slot, fiber } of this.passRemoved.reverse()) {
        if (this.dead) unmountFiber(fiber);
        else parent.children.set(slot, fiber);
      }
    }
    runEffects() {
      const queued = this.effects;
      this.effects = [];
      for (const { fiber, hook } of queued) {
        if (!fiber.alive || !hook.cleanup) continue;
        const cleanup = hook.cleanup;
        hook.cleanup = void 0;
        try {
          cleanup();
        } catch (error) {
          this.report(error);
        }
      }
      for (const { fiber, hook } of queued) {
        const effect = hook.next;
        hook.next = void 0;
        if (!fiber.alive || !effect) continue;
        try {
          const result = effect();
          if (isThenable(result)) result.then(void 0, (error) => this.report(error));
          const cleanup = typeof result === "function" ? result : void 0;
          if (fiber.alive) hook.cleanup = cleanup;
          else cleanup?.();
        } catch (error) {
          this.report(error);
        }
      }
    }
    claim(parent, slot, type, key) {
      let fiber = parent.children.get(slot);
      if (fiber && (fiber.type !== type || (fiberKeys.get(fiber) ?? null) !== key)) {
        this.passRemoved.push({ parent, slot, fiber });
        fiber = void 0;
      }
      if (!fiber) {
        fiber = newFiber(type, `${parent.path}/${slot}`, this);
        if (key !== null) fiberKeys.set(fiber, key);
        parent.children.set(slot, fiber);
        this.passCreated.push({ parent, slot, fiber });
      }
      parent.seen.add(slot);
      return fiber;
    }
    sweep(fiber) {
      for (const [slot, child] of fiber.children) {
        if (fiber.seen.has(slot)) continue;
        this.passRemoved.push({ parent: fiber, slot, fiber: child });
        fiber.children.delete(slot);
      }
    }
    renderValue(parent, slot, value, context, inheritedKey) {
      if (value === null || value === void 0 || typeof value === "boolean") return [];
      if (typeof value === "string") return [value];
      if (typeof value === "number" || typeof value === "bigint") return [String(value)];
      if (Array.isArray(value)) return this.renderList(parent, slot, value, context);
      if (!isVNode(value)) throw new TypeError(`A component returned ${describe(value)}; return an element, text, a list or null.`);
      const fiber = this.claim(parent, slot, value.type, value.key ?? null);
      const key = value.key ?? inheritedKey;
      const hostType = hostTypeOf(value.type);
      fiber.seen.clear();
      const rendered = hostType ? [this.renderHost(fiber, hostType, value.props, key, context)] : this.renderComponent(fiber, value, key, context);
      this.sweep(fiber);
      return rendered;
    }
    renderList(parent, slot, items, context) {
      const out = [];
      items.forEach((item, index) => {
        let itemSlot = isVNode(item) && item.key !== null ? `${slot}:k${typeof item.key === "number" ? "n" : "s"}=${String(item.key)}` : `${slot}:i=${index}`;
        if (parent.seen.has(itemSlot)) itemSlot = `${itemSlot}~${index}`;
        for (const node of this.renderValue(parent, itemSlot, item, context, null)) out.push(node);
      });
      return out;
    }
    renderComponent(fiber, node, key, context) {
      const provided = providerOf(node.type);
      if (provided) {
        const inner = new Map(context);
        inner.set(provided, node.props.value);
        return this.renderValue(fiber, "c", node.props.children, inner, key);
      }
      const consumed = consumerOf(node.type);
      if (consumed && context.has(consumed)) {
        const read = node.props.children;
        return this.renderValue(fiber, "c", read(context.get(consumed)), context, key);
      }
      fiber.context = context;
      if (fiber.hooks.length > 0) {
        const effectDeps = [];
        for (const hook of fiber.hooks) if (hook.kind === "effect") effectDeps.push([hook, hook.deps]);
        this.passRendered.push({ fiber, hookCount: fiber.hooks.length, effectDeps });
      }
      beginHooks(fiber);
      let result;
      try {
        result = node.type(node.props);
      } finally {
        endHooks();
      }
      return this.renderValue(fiber, "c", result, context, key);
    }
    renderHost(fiber, type, props, key, context) {
      const serialized = {};
      for (const name of Object.keys(props)) {
        if (name === "children") continue;
        const value = this.serialize(fiber, `p.${name}`, props[name], context);
        if (value !== void 0) serialized[name] = value;
      }
      const node = { type, props: serialized, children: this.renderValue(fiber, "c", props.children, context, null) };
      if (key !== null) node.key = key;
      return node;
    }
    handlerRef(path, handler) {
      let id = this.handlerIds.get(path);
      if (!id) {
        id = `${this.handlerPrefix}${++this.nextHandler}`;
        this.handlerIds.set(path, id);
      }
      this.passHandlers.set(id, handler);
      this.passPaths.add(path);
      return { __handler: id };
    }
    serialize(fiber, path, value, context) {
      if (value === void 0 || typeof value === "symbol") return void 0;
      if (typeof value === "function") return this.handlerRef(`${serialOf(fiber)}|${path}`, value);
      if (isVNode(value)) {
        const nodes = this.renderValue(fiber, path, value, context, null);
        if (nodes.length === 0) return null;
        return nodes.length === 1 ? nodes[0] : asTree(nodes);
      }
      if (Array.isArray(value)) return value.map((item, index) => this.serialize(fiber, `${path}[${index}]`, item, context) ?? null);
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "bigint") return String(value);
      if (isPlainObject(value)) {
        const out = {};
        for (const name of Object.keys(value)) {
          const item = this.serialize(fiber, `${path}.${name}`, value[name], context);
          if (item !== void 0) out[name] = item;
        }
        return out;
      }
      return value;
    }
  };
  function mountSurface(root, initialProps, onCommit, options = {}) {
    const surface = new Surface(root, initialProps, onCommit, options);
    surface.render();
    return surface;
  }

  var SurfaceContext = createContext(null);
  function useSurface() {
    const surface = useContext(SurfaceContext);
    if (!surface) throw new Error("useSurface only works inside a view the host mounted.");
    return surface;
  }
  function MissingView({ viewId }) {
    return jsx("EmptyState", {
      icon: "questionmark.square.dashed",
      title: "No view to show",
      description: `This plugin hasn't registered a view called ${viewId}.`,
      tone: "warning"
    });
  }
  function SurfaceRoot({ view, surface }) {
    const props = { surfaceId: surface.surfaceId, viewId: surface.viewId, kind: surface.kind, context: surface.context };
    return jsx(SurfaceContext.Provider, { value: surface, children: jsx(view, props) });
  }
  function isThenable2(value) {
    return typeof value === "object" && value !== null && typeof value.then === "function";
  }
  var NO_HANDLERS = new Map();
  function createSurfaceHost(rpc, registry, report) {
    const mounted = new Map();
    function unmount(surfaceId) {
      const entry = mounted.get(surfaceId);
      if (!entry) return;
      mounted.delete(surfaceId);
      entry.handle.unmount();
    }
    function mount(message) {
      unmount(message.surfaceId);
      const surface = {
        surfaceId: message.surfaceId,
        viewId: message.viewId,
        kind: message.kind,
        context: message.context ?? {},
        close: () => rpc.request(HOST_METHODS.surfaceClose, { surfaceId: message.surfaceId }).then(() => void 0)
      };
      const view = registry.views.get(message.viewId) ?? MissingView;
      let generation = 0;
      let acceptedGeneration = 0;
      let latest = NO_HANDLERS;
      let shown = NO_HANDLERS;
      const isCurrent = () => mounted.get(message.surfaceId)?.handle === handle;
      const sendTree = (tree, sent, handlers) => rpc.request(HOST_METHODS.surfaceRender, { surfaceId: message.surfaceId, tree }).then(() => {
        if (sent < acceptedGeneration) return;
        acceptedGeneration = sent;
        shown = handlers;
      });
      const commit = (tree, handlers) => {
        const sent = ++generation;
        latest = handlers;
        sendTree(tree, sent, handlers).catch((error) => {
          report(error);
          if (sent !== generation || !isCurrent()) return;
          latest = NO_HANDLERS;
          sendTree(errorNode(error), sent, NO_HANDLERS).catch(report);
        });
      };
      const handle = mountSurface(SurfaceRoot, { view, surface }, commit, { onError: report });
      mounted.set(message.surfaceId, { handle, handler: (handlerId) => shown.get(handlerId) ?? latest.get(handlerId) });
    }
    function dispatch(surfaceId, handlerId, args) {
      const entry = mounted.get(surfaceId);
      if (!entry) return report(new Error(`An event arrived for ${surfaceId}, which isn't mounted.`));
      try {
        const handler = entry.handler(handlerId);
        if (!handler) throw new Error(`There's no handler ${handlerId}; the view re-rendered without it.`);
        const result = handler(...Array.isArray(args) ? args : []);
        if (isThenable2(result)) result.then(void 0, report);
      } catch (error) {
        report(error);
      }
    }
    return {
      handle(message) {
        if (message.surface === "mount") mount(message);
        else if (message.surface === "unmount") unmount(message.surfaceId);
        else dispatch(message.surfaceId, message.handlerId, message.args);
      },
      count: () => mounted.size,
      tree: (surfaceId) => mounted.get(surfaceId)?.handle.tree ?? null,
      closeAll() {
        for (const id of [...mounted.keys()]) unmount(id);
      }
    };
  }

  var SDK_VERSION = "2.1.0";
  var DEFAULT_STOP_GRACE_MS = 5e3;
  function createSignal() {
    const listeners = new Set();
    let cancelled = false;
    return {
      get cancelled() {
        return cancelled;
      },
      onCancel(listener) {
        if (cancelled) listener();
        else listeners.add(listener);
        return disposable(() => listeners.delete(listener));
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        for (const listener of listeners) listener();
        listeners.clear();
      }
    };
  }
  function cleanSuggestion(value) {
    if (typeof value !== "object" || value === null) return null;
    const { title, url, subtitle, icon, badge } = value;
    if (typeof title !== "string" || typeof url !== "string") return null;
    const out = { title, url };
    if (typeof subtitle === "string") out.subtitle = subtitle;
    if (typeof icon === "string") out.icon = icon;
    if (typeof badge === "string") out.badge = badge;
    return out;
  }
  function queryOf(input) {
    if (typeof input === "string") return input;
    if (typeof input === "object" && input !== null) {
      const { query, text } = input;
      if (typeof query === "string") return query;
      if (typeof text === "string") return text;
    }
    return "";
  }
  var CALL_KINDS = ["tool", "command", "omnibox", "decide"];
  function inputOf(kind, message) {
    if (message.input !== void 0) return message.input;
    if (kind === "decide") return message.data;
    if (kind === "omnibox") return message.query;
    return void 0;
  }
  function createHostRuntime(transport, options = {}) {
    const rpc = createRpc(transport);
    const registry = createRegistry();
    const calls = new Map();
    const report = (error) => {
      if (options.onError) options.onError(error);
      else globalThis.console?.error?.("[ardia plugin]", error);
    };
    let activation = Promise.resolve();
    let activated = false;
    let stopped = false;
    let stopping = null;
    let acknowledgedEvents = "";
    let subscribeQueued = false;
    let subscribeInFlight = false;
    let work = Promise.resolve();
    let cleanup = async () => surfaces.closeAll();
    const stop = () => {
      if (stopping) return stopping;
      stopped = true;
      let begin;
      stopping = new Promise((resolve) => begin = resolve).then(() => cleanup());
      const running = [...calls.values()];
      calls.clear();
      for (const signal of running) {
        try {
          signal.cancel();
        } catch (error) {
          report(error);
        }
      }
      begin();
      return stopping;
    };
    const stopWithinGrace = async () => {
      const { setTimeout: startTimer, clearTimeout: cancelTimer } = globalThis;
      if (!startTimer || !cancelTimer) return stop();
      let timer;
      const graceOver = new Promise((resolve) => timer = startTimer(resolve, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS));
      try {
        await Promise.race([stop(), graceOver]);
      } finally {
        cancelTimer(timer);
      }
    };
    const wantedEvents = () => [...registry.events.keys()].filter((name) => name !== "plugin.values").sort();
    const syncSubscriptions = () => {
      if (!activated || stopped || subscribeQueued || subscribeInFlight) return;
      subscribeQueued = true;
      enqueueMicrotask(() => {
        subscribeQueued = false;
        void sendSubscriptions();
      });
    };
    async function sendSubscriptions() {
      if (stopped || subscribeInFlight) return;
      const events = wantedEvents();
      const signature = events.join(",");
      if (signature === acknowledgedEvents) return;
      subscribeInFlight = true;
      let failed = false;
      try {
        await rpc.request(HOST_METHODS.subscribe, { events });
        acknowledgedEvents = signature;
      } catch (error) {
        failed = true;
        report(error);
      } finally {
        subscribeInFlight = false;
      }
      if (!failed || wantedEvents().join(",") !== signature) syncSubscriptions();
    }
    const state = {
      values: {},
      info: { name: "", app: "", version: "", protocol: 0 },
      subscriptionsChanged: syncSubscriptions
    };
    const ardia2 = createArdia(rpc, registry, state);
    const surfaces = createSurfaceHost(rpc, registry, report);
    const whenActive = (task, refuse) => {
      work = work.then(() => activation).then(
        () => stopped ? void 0 : task(),
        (activationError) => stopped ? void 0 : refuse?.(activationError)
      ).then(
        () => void 0,
        (error) => report(error)
      );
    };
    async function dispatchCall(kind, name, input, call) {
      if (kind === "tool") {
        const tool = registry.tools.get(name);
        if (!tool) throw new Error(`This plugin has no tool ${name}.`);
        return tool(input, call);
      }
      if (kind === "command") {
        const command = registry.commands.get(name);
        if (!command) throw new Error(`This plugin has no command ${name}.`);
        return command(input, call);
      }
      if (kind === "decide") {
        const decide = registry.decide.get(name);
        if (!decide) throw new Error(`This plugin doesn't decide ${name}.`);
        return decide(input ?? {}, call);
      }
      const query = queryOf(input);
      const lists = await Promise.all([...registry.omnibox].map(async (provider) => await provider(query, call) ?? []));
      return lists.flat().map(cleanSuggestion).filter((s) => s !== null);
    }
    const forgetCall = (callId, signal) => {
      if (calls.get(callId) === signal) calls.delete(callId);
    };
    async function answer(message, signal) {
      if (signal.cancelled) return forgetCall(message.call, signal);
      const kind = message.kind && CALL_KINDS.includes(message.kind) ? message.kind : "tool";
      const name = message.name ?? message.tool ?? message.command ?? message.event ?? message.provider ?? "";
      const call = {
        callId: message.call,
        kind,
        name,
        context: message.context ?? {},
        caller: message.caller ?? null,
        deadline: typeof message.deadline === "number" ? message.deadline : void 0,
        signal
      };
      let body;
      try {
        const result = await dispatchCall(kind, name, inputOf(kind, message), call);
        body = { call: message.call, result: result === void 0 ? null : result };
      } catch (error) {
        body = { call: message.call, error: errorMessage(error) };
      } finally {
        forgetCall(message.call, signal);
      }
      if (signal.cancelled) return;
      await sendResult(body);
    }
    async function sendResult(body) {
      try {
        await rpc.request(HOST_METHODS.result, body);
      } catch (error) {
        if (!isUnencodable(error)) return report(error);
        await rpc.request(HOST_METHODS.result, { call: body.call, error: `The plugin's result couldn't be sent: ${errorMessage(error)}` }).catch(report);
      }
    }
    async function refuseCall(message, signal, activationError) {
      forgetCall(message.call, signal);
      if (signal.cancelled) return;
      await sendResult({ call: message.call, error: `The plugin didn't activate: ${errorMessage(activationError)}` });
    }
    function deliverEvent(name, data, time) {
      if (name === "plugin.values") {
        const values = data.values ?? data;
        state.values = { ...state.values, ...values };
        for (const listener of [...registry.settings]) listener({ ...state.values });
      }
      const targets = [...registry.events.get(name) ?? [], ...name === "plugin.values" ? [] : registry.events.get("*") ?? []];
      for (const listener of targets) {
        try {
          listener(data, { name, time });
        } catch (error) {
          report(error);
        }
      }
    }
    function handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return report(new Error(`The host sent a line that isn't JSON: ${line.slice(0, 120)}`));
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const record = message;
      if (rpc.takeReply(record) || stopped) return;
      if (isSurfaceMessage(record)) return whenActive(() => surfaces.handle(record));
      if (typeof record.call === "string") {
        if (record.cancel === true) return calls.get(record.call)?.cancel();
        const signal = createSignal();
        calls.set(record.call, signal);
        return whenActive(
          () => void answer(record, signal),
          (activationError) => void refuseCall(record, signal, activationError)
        );
      }
      if ("pageMessage" in record) {
        const view = typeof record.view === "string" ? record.view : "";
        return whenActive(() => {
          for (const listener of [...registry.pages]) listener(record.pageMessage, view);
        });
      }
      if (typeof record.event === "string") {
        const data = typeof record.data === "object" && record.data !== null ? record.data : {};
        const time = typeof record.time === "number" ? record.time : void 0;
        if (record.event === "plugin.values") return deliverEvent(record.event, data, time);
        if (record.event === "plugin.stopping") return void stop().catch(report);
        return whenActive(() => deliverEvent(record.event, data, time));
      }
    }
    transport.onLine((line) => {
      try {
        handleLine(line);
      } catch (error) {
        report(error);
      }
    });
    function register(definition) {
      const held = [];
      for (const [name, handler] of Object.entries(definition.commands ?? {})) held.push(ardia2.commands.register(name, handler));
      for (const [name, handler] of Object.entries(definition.tools ?? {})) held.push(ardia2.tools.register(name, handler));
      for (const [id, view] of Object.entries(definition.views ?? {})) held.push(ardia2.views.register(id, view));
      for (const [name, handler] of Object.entries(definition.decide ?? {})) held.push(ardia2.hooks.decide(name, handler));
      for (const [name, listener] of Object.entries(definition.events ?? {})) held.push(ardia2.hooks.on(name, listener));
      if (definition.omnibox) held.push(ardia2.omnibox.register(definition.omnibox));
      if (definition.onPageMessage) held.push(ardia2.pages.onMessage(definition.onPageMessage));
      if (definition.onSettingsChange) held.push(ardia2.settings.onChange(definition.onSettingsChange));
      return held;
    }
    const readyParams = () => ({
      commands: [...registry.commands.keys()],
      tools: [...registry.tools.keys()],
      views: [...registry.views.keys()],
      omnibox: registry.omnibox.size > 0,
      decide: [...registry.decide.keys()],
      events: [...registry.events.keys()]
    });
    function definePlugin2(definition) {
      const held = register(definition);
      cleanup = async () => {
        surfaces.closeAll();
        for (const item of held.splice(0).reverse()) {
          try {
            item.dispose();
          } catch (error) {
            report(error);
          }
        }
        if (definition.deactivate) await definition.deactivate();
      };
      activation = (async () => {
        const hello = await rpc.request(HOST_METHODS.hello, { protocol: PLUGIN_PROTOCOL, sdk: SDK_VERSION }).catch((error) => {
          report(error);
          return null;
        }) ?? { app: "", version: "", protocol: 0, plugin: "" };
        if (stopped) return;
        state.info = { name: hello.plugin, app: hello.app, version: hello.version, protocol: hello.protocol };
        state.values = { ...hello.values ?? {}, ...state.values };
        const returned = definition.activate ? await definition.activate(ardia2) : void 0;
        if (returned && typeof returned.dispose === "function") {
          if (stopped) returned.dispose();
          else held.push(returned);
        }
        if (stopped) return;
        activated = true;
        syncSubscriptions();
      })();
      const ready = activation.then(() => stopped ? void 0 : rpc.request(HOST_METHODS.ready, readyParams())).then(() => void 0);
      ready.catch(report);
      return ready;
    }
    return {
      ardia: ardia2,
      registry,
      definePlugin: definePlugin2,
      request: (method, params) => rpc.request(method, params),
      surfaceCount: () => surfaces.count(),
      callCount: () => calls.size,
      surfaceTree: (surfaceId) => surfaces.tree(surfaceId),
      whenIdle: async () => {
        for (let i = 0; i < 20; i++) {
          const pending = work;
          await pending;
          await new Promise((resolve) => enqueueMicrotask(resolve));
          if (pending === work) return;
        }
      },
      dispose: async () => {
        try {
          await stopWithinGrace();
        } finally {
          rpc.close(new PluginError("stopped", "The plugin stopped."));
        }
      }
    };
  }

  var Box = hostComponent("Box");
  var Text = hostComponent("Text");
  var Markdown = hostComponent("Markdown");
  var Badge = hostComponent("Badge");
  var Button = hostComponent("Button");
  var Divider = hostComponent("Divider");
  var EmptyState = hostComponent("EmptyState");
  var Progress = hostComponent("Progress");
  var ActionPanel = hostComponent("ActionPanel");
  var Popover = hostComponent("Popover");
  var WebView = hostComponent("WebView");
  var ActionHost = hostComponent("Action");
  function OpenInBrowser({ url, title = "Open in Browser", icon = "safari", shortcut }) {
    return jsx(ActionHost, { title, icon, url, shortcut });
  }
  function CopyToClipboard({ content, title = "Copy to Clipboard", icon = "doc.on.doc", shortcut, onCopy }) {
    return jsx(ActionHost, { title, icon, copy: content, shortcut, onAction: onCopy });
  }
  var Action = Object.assign(ActionHost, { OpenInBrowser, CopyToClipboard });
  var List = Object.assign(hostComponent("List"), {
    Section: hostComponent("ListSection"),
    Item: hostComponent("ListItem")
  });
  var Detail = hostComponent("Detail");
  var Form = Object.assign(hostComponent("Form"), {
    TextField: hostComponent("TextField"),
    PasswordField: hostComponent("PasswordField"),
    Toggle: hostComponent("Toggle"),
    Select: hostComponent("Select")
  });
  var SidebarView = Object.assign(hostComponent("SidebarView"), {
    Section: hostComponent("SidebarSection"),
    Item: hostComponent("SidebarItem")
  });

  var shared = null;
  function bridge() {
    const found = globalThis.__ardiaBridge;
    if (!found || typeof found.send !== "function" || typeof found.onLine !== "function") {
      throw new Error("There's no __ardiaBridge; plugins built with @ardia/plugin-sdk run inside Ardia's plugin host.");
    }
    return found;
  }
  function sharedRuntime() {
    shared ??= createHostRuntime(bridge());
    return shared;
  }
  var ardia = new Proxy({}, {
    get: (_target, key) => Reflect.get(sharedRuntime().ardia, key),
    has: (_target, key) => Reflect.has(sharedRuntime().ardia, key)
  });
  function definePlugin(definition) {
    return sharedRuntime().definePlugin(definition);
  }

  var REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  var isRepoName = (value) => REPO_NAME.test(value.trim());
  function formatCount(count) {
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
    return String(count);
  }
  function hostOf(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
    return match ? match[1].replace(/^www\./, "") : url;
  }
  async function repoStats(repo) {
    const name = repo.trim();
    if (!isRepoName(name)) throw new Error(`${repo} isn't owner/name.`);
    const token = await ardia.secrets.get("githubToken");
    const headers = { accept: "application/vnd.github+json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response2 = await ardia.net.fetch({ url: `https://api.github.com/repos/${name}`, headers, timeoutMs: 1e4 });
    if (!response2.ok) throw new Error(`GitHub answered ${response2.status} for ${name}.`);
    const data = response2.json();
    return {
      fullName: String(data.full_name ?? name),
      description: typeof data.description === "string" ? data.description : "",
      stars: Number(data.stargazers_count ?? 0),
      forks: Number(data.forks_count ?? 0),
      openIssues: Number(data.open_issues_count ?? 0),
      language: typeof data.language === "string" ? data.language : null,
      url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${name}`
    };
  }
  async function starredRepos() {
    return await ardia.storage.get("starred") ?? [];
  }
  async function toggleStar(repo) {
    const current2 = await starredRepos();
    const next = current2.includes(repo) ? current2.filter((r) => r !== repo) : [...current2, repo];
    await ardia.storage.set("starred", next);
    return next;
  }
  function useStarred() {
    const [starred, setStarred] = useState([]);
    useEffect(() => {
      let live = true;
      void starredRepos().then((list) => live && setStarred(list));
      return () => {
        live = false;
      };
    }, []);
    return [starred, async (repo) => setStarred(await toggleStar(repo))];
  }
  function useTabs() {
    const [tabs, setTabs] = useState(null);
    useEffect(() => {
      let live = true;
      const load = () => void ardia.tabs.query().then((list) => live && setTabs(list));
      load();
      const listeners = ["tab.opened", "tab.closed", "tab.activated"].map((name) => ardia.hooks.on(name, load));
      return () => {
        live = false;
        for (const listener of listeners) listener.dispose();
      };
    }, []);
    return tabs;
  }
  function useRepo(repo) {
    const [state, setState] = useState({ stats: null, error: null, loading: false });
    useEffect(() => {
      if (!repo) return;
      let live = true;
      setState((s) => ({ ...s, loading: true, error: null }));
      repoStats(repo).then(
        (stats) => live && setState({ stats, error: null, loading: false }),
        (error) => live && setState({ stats: null, error: error instanceof Error ? error.message : String(error), loading: false })
      );
      return () => {
        live = false;
      };
    }, [repo]);
    return state;
  }

  async function pickTab() {
    const tabs = await ardia.tabs.query();
    const items = tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || hostOf(tab.url),
      subtitle: hostOf(tab.url),
      icon: tab.pinned ? "pin.fill" : "globe",
      badge: tab.active ? "Current" : void 0,
      keywords: [hostOf(tab.url)]
    }));
    const picked = await ardia.ui.quickPick(items, { title: "Jump to a Tab", placeholder: "Search open tabs" });
    if (!picked) return null;
    await ardia.tabs.activate(picked.id);
    return { tabId: picked.id };
  }
  async function closeTabs() {
    const tabs = await ardia.tabs.query({ active: false, pinned: false });
    const picked = await ardia.ui.quickPick(
      tabs.map((tab) => ({ id: tab.id, title: tab.title || hostOf(tab.url), subtitle: hostOf(tab.url), icon: "globe" })),
      { title: "Close Tabs", placeholder: "Pick tabs to close", canPickMany: true }
    );
    if (!picked?.length) return { closed: 0 };
    const sure = await ardia.ui.confirm({ title: `Close ${picked.length} tabs?`, confirmTitle: "Close", destructive: true });
    if (!sure) return { closed: 0 };
    await ardia.workspace.apply([{ op: "tab.close", tabs: picked.map((item) => item.id) }]);
    await ardia.ui.toast(`Closed ${picked.length} tabs`, void 0, { icon: "xmark.circle", tone: "success" });
    return { closed: picked.length };
  }
  async function setDefaultRepo() {
    const value = await ardia.ui.inputBox({
      title: "Default repository",
      message: "The toolbar popover starts with this one.",
      placeholder: "owner/name",
      value: ardia.settings.get("defaultRepo", "nodejs/node"),
      confirmTitle: "Save"
    });
    if (value === void 0) return null;
    if (!isRepoName(value)) {
      await ardia.ui.toast(`${value} isn't owner/name`, "Use the owner/name form, like nodejs/node.", { icon: "exclamationmark.triangle", tone: "warning" });
      return null;
    }
    await ardia.storage.set("defaultRepo", value.trim());
    await ardia.ui.toast("Default repository saved", value.trim(), { icon: "checkmark.circle", tone: "success" });
    return value.trim();
  }
  async function setToken() {
    const token = await ardia.ui.inputBox({ title: "GitHub token", message: "Kept in your Keychain; only this plugin reads it.", password: true, confirmTitle: "Save" });
    if (token === void 0) return { saved: false };
    if (token === "") await ardia.secrets.delete("githubToken");
    else await ardia.secrets.set("githubToken", token);
    await ardia.ui.toast(token ? "Token saved" : "Token removed", void 0, { icon: "key", tone: "success" });
    return { saved: token !== "" };
  }
  async function checkStars(input = {}) {
    const repo = input.repo ?? (await ardia.storage.get("defaultRepo") || ardia.settings.get("defaultRepo", "nodejs/node"));
    const stats = await repoStats(repo);
    await ardia.toolbar.update("showcase", { badge: formatCount(stats.stars), tooltip: `${stats.fullName} · ${stats.stars} stars` });
    await ardia.ui.toast(stats.fullName, `${formatCount(stats.stars)} stars`, { icon: "star.fill", tone: "accent" });
    return { repo: stats.fullName, stars: stats.stars };
  }
  async function tabSummary(_input, call) {
    const tabId = typeof call.context.tabId === "string" ? call.context.tabId : null;
    const tabs = await ardia.tabs.query();
    const tab = tabs.find((t) => t.id === tabId) ?? tabs.find((t) => t.active);
    if (!tab) return null;
    await ardia.ui.toast(tab.title || "Untitled", hostOf(tab.url), { icon: "info.circle" });
    return { title: tab.title, host: hostOf(tab.url) };
  }
  async function omniboxSuggestions(query) {
    const typed = query.trim();
    const starred = await starredRepos();
    const matches = starred.filter((repo) => repo.toLowerCase().includes(typed.toLowerCase())).slice(0, 5).map((repo) => ({ title: repo, url: `https://github.com/${repo}`, subtitle: "Starred in V2 Showcase", icon: "star.fill", badge: "★" }));
    if (!typed) return matches;
    const direct = isRepoName(typed) ? [{ title: `Open ${typed}`, url: `https://github.com/${typed}`, subtitle: "github.com", icon: "arrow.up.right.square" }] : [];
    const search = { title: `Search GitHub for “${typed}”`, url: `https://github.com/search?q=${encodeURIComponent(typed)}&type=repositories`, icon: "magnifyingglass" };
    return [...direct, ...matches.filter((m) => m.title !== typed), search];
  }
  function blockedHosts() {
    return String(ardia.settings.get("blockedHosts", "")).split(/[\s,]+/).map((host) => host.trim().toLowerCase()).filter(Boolean);
  }
  function decideTabOpening(data) {
    if (!ardia.settings.get("focusGuard", false) || typeof data.url !== "string") return null;
    const host = hostOf(data.url).toLowerCase();
    const blocked = blockedHosts().some((entry) => host === entry || host.endsWith(`.${entry}`));
    return blocked ? { cancel: true } : null;
  }

  var toneSetting = () => ardia.settings.get("badgeTone", "accent");
  function ShowcaseSidebar(_props) {
    const tabs = useTabs();
    const [starred, toggle] = useStarred();
    const pinned = useMemo(() => (tabs ?? []).filter((t) => t.pinned).length, [tabs]);
    return jsxs(
      SidebarView,
      {
        title: "Showcase",
        isLoading: tabs === null,
        actions: jsxs(ActionPanel, { children: [
          jsx(Action, { title: "Open Sidecar", icon: "rectangle.righthalf.inset.filled", onAction: () => ardia.panels.open("sidecar") }),
          jsx(Action, { title: "Jump to a Tab…", icon: "rectangle.stack", shortcut: "cmd+shift+j", onAction: pickTab })
        ] }),
        children: [
          jsx(SidebarView.Section, { title: `Open tabs · ${tabs?.length ?? 0}`, children: (tabs ?? []).slice(0, 12).map((tab) => jsx(
            SidebarView.Item,
            {
              id: tab.id,
              title: tab.title || hostOf(tab.url),
              subtitle: hostOf(tab.url),
              icon: tab.pinned ? "pin.fill" : "globe",
              selected: tab.active,
              onPress: () => ardia.tabs.activate(tab.id),
              actions: jsxs(ActionPanel, { children: [
                jsx(Action.CopyToClipboard, { title: "Copy Address", content: tab.url }),
                jsx(Action, { title: "Close Tab", icon: "xmark", destructive: true, onAction: () => ardia.tabs.close(tab.id) })
              ] })
            },
            tab.id
          )) }),
          jsx(SidebarView.Section, { title: "Starred repositories", collapsible: true, children: starred.length === 0 ? jsx(EmptyState, { icon: "star", title: "Nothing starred yet", description: "Star a repository from the toolbar popover or the gh omnibox keyword." }) : starred.map((repo) => jsx(
            SidebarView.Item,
            {
              title: repo,
              icon: "star.fill",
              tone: toneSetting(),
              onPress: () => ardia.tabs.open(`https://github.com/${repo}`, { activate: true }),
              actions: jsxs(ActionPanel, { children: [
                jsx(Action.OpenInBrowser, { url: `https://github.com/${repo}` }),
                jsx(Action, { title: "Unstar", icon: "star.slash", destructive: true, onAction: () => toggle(repo) })
              ] })
            },
            repo
          )) }),
          jsx(Box, { padding: "s", gap: "xs", children: jsxs(Text, { size: "caption", tone: "tertiary", children: [
            pinned,
            " pinned · ",
            starred.length,
            " starred"
          ] }) })
        ]
      }
    );
  }
  function ToolbarPopover(_props) {
    const surface = useSurface();
    const [draft, setDraft] = useState(ardia.settings.get("defaultRepo", "nodejs/node"));
    const [checked, setChecked] = useState(null);
    const [showBadge, setShowBadge] = useState(true);
    const { stats, error, loading } = useRepo(checked);
    const [starred, toggle] = useStarred();
    const submit = async () => {
      if (!isRepoName(draft)) return;
      setChecked(draft.trim());
    };
    useEffect(() => {
      if (!stats) return;
      const badge = showBadge ? formatCount(stats.stars) : null;
      void ardia.toolbar.update("showcase", { badge, tooltip: `${stats.fullName} · ${stats.stars} stars`, tone: toneSetting() });
    }, [stats, showBadge]);
    return jsxs(Popover, { title: "V2 Showcase", width: 340, children: [
      jsxs(Form, { submitTitle: "Check Stars", isLoading: loading, onSubmit: submit, children: [
        jsx(
          Form.TextField,
          {
            id: "repo",
            title: "Repository",
            placeholder: "owner/name",
            value: draft,
            onChange: setDraft,
            error: draft && !isRepoName(draft) ? "Use owner/name" : error ?? void 0,
            autoFocus: true
          }
        ),
        jsx(Form.Toggle, { id: "badge", label: "Show stars on the toolbar", value: showBadge, onChange: setShowBadge })
      ] }),
      loading ? jsx(Progress, { label: "Asking GitHub…" }) : null,
      stats ? jsxs(Box, { gap: "xs", padding: "s", background: "subtle", radius: "s", children: [
        jsxs(Box, { direction: "row", gap: "s", align: "center", children: [
          jsx(Text, { weight: "semibold", children: stats.fullName }),
          jsx(Badge, { tone: toneSetting(), icon: "star.fill", children: formatCount(stats.stars) })
        ] }),
        jsx(Text, { size: "small", tone: "secondary", lines: 2, children: stats.description || "No description." }),
        jsx(
          Button,
          {
            title: starred.includes(stats.fullName) ? "Unstar" : "Star",
            icon: starred.includes(stats.fullName) ? "star.slash" : "star",
            variant: "secondary",
            onPress: () => toggle(stats.fullName)
          }
        )
      ] }) : null,
      jsx(Divider, {}),
      jsxs(Box, { direction: "row", gap: "s", justify: "between", children: [
        jsx(Button, { title: "Open Sidecar", icon: "rectangle.righthalf.inset.filled", onPress: () => ardia.panels.open("sidecar") }),
        jsx(Button, { title: "Done", variant: "plain", onPress: () => surface.close() })
      ] })
    ] });
  }
  function RepoBrowser({ context }) {
    const [search, setSearch] = useState(context.query ?? "");
    const [starred, toggle] = useStarred();
    const [selected, setSelected] = useState(null);
    const { stats, loading } = useRepo(selected);
    const candidates = useMemo(() => {
      const typed = search.trim();
      const list = [...starred];
      if (isRepoName(typed) && !list.includes(typed)) list.unshift(typed);
      return list.filter((repo) => repo.toLowerCase().includes(typed.toLowerCase()) || repo === typed);
    }, [search, starred]);
    return jsx(
      List,
      {
        searchBarPlaceholder: "owner/name",
        searchText: search,
        onSearchTextChange: setSearch,
        selectedItemId: selected ?? void 0,
        onSelectionChange: setSelected,
        isShowingDetail: true,
        emptyView: jsx(EmptyState, { icon: "magnifyingglass", title: "Type a repository", description: "Like nodejs/node. Starred ones show here." }),
        children: jsx(List.Section, { title: "Repositories", subtitle: `${candidates.length}`, children: candidates.map((repo) => jsx(
          List.Item,
          {
            id: repo,
            title: repo,
            icon: starred.includes(repo) ? "star.fill" : "book.closed",
            keywords: repo.split("/"),
            accessories: selected === repo && stats ? [{ icon: "star", text: formatCount(stats.stars), tone: toneSetting() }] : [],
            detail: jsx(
              Detail,
              {
                isLoading: selected === repo && loading,
                markdown: selected === repo && stats ? `# ${stats.fullName}

${stats.description}` : `# ${repo}`,
                metadata: selected === repo && stats ? [
                  { label: "Stars", text: formatCount(stats.stars), icon: "star" },
                  { label: "Forks", text: formatCount(stats.forks), icon: "tuningfork" },
                  { label: "Open issues", text: String(stats.openIssues) },
                  { label: "Language", text: stats.language ?? "Unknown" }
                ] : []
              }
            ),
            actions: jsxs(ActionPanel, { title: repo, children: [
              jsx(Action.OpenInBrowser, { url: `https://github.com/${repo}` }),
              jsx(Action, { title: starred.includes(repo) ? "Unstar" : "Star", icon: "star", shortcut: "cmd+s", onAction: () => toggle(repo) }),
              jsx(Action.CopyToClipboard, { content: `https://github.com/${repo}`, title: "Copy Link", onCopy: () => ardia.ui.toast("Link copied", void 0, { icon: "link" }) })
            ] })
          },
          repo
        )) })
      }
    );
  }

  var visits = 0;
  async function answerPage(message, view) {
    const request = typeof message === "object" && message !== null ? message : {};
    const reply = (body) => ardia.pages.post(view, { requestId: request.requestId, ...body });
    try {
      if (request.type === "hello") return await reply({ type: "page", page: await ardia.tabs.activePage().catch(() => null), plugin: ardia.plugin, settings: ardia.settings.all() });
      if (request.type === "stats" && request.repo) return await reply({ type: "stats", stats: await repoStats(request.repo) });
      if (request.type === "star" && request.repo) return await reply({ type: "starred", starred: await toggleStar(request.repo) });
      await reply({ type: "error", message: `Unknown request ${String(request.type)}` });
    } catch (error) {
      await reply({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  void definePlugin({
    async activate() {
      await ardia.toolbar.update("showcase", { icon: "sparkles", label: null, badge: null, tooltip: "V2 Showcase" });
    },
    commands: {
      "pick-tab": pickTab,
      "close-tabs": closeTabs,
      "set-default-repo": setDefaultRepo,
      "set-token": setToken,
      "check-stars": checkStars,
      "tab-summary": tabSummary,
      "open-sidecar": () => ardia.panels.open("sidecar")
    },
    tools: {
      "repo-stars": (input) => repoStats(input.repo),
      "active-page": () => ardia.tabs.activePage()
    },
    views: {
      sidebar: ShowcaseSidebar,
      "toolbar-popover": ToolbarPopover,
      "repo-browser": RepoBrowser
    },
    omnibox: omniboxSuggestions,
    decide: {
      "tab.opening": decideTabOpening
    },
    events: {
      "tab.activated": () => {
        visits++;
        if (ardia.settings.get("countVisits", true)) void ardia.toolbar.update("showcase", { label: visits > 0 ? `${visits}` : null });
      }
    },
    onPageMessage: (message, view) => void answerPage(message, view),
    onSettingsChange: (values) => {
      if (values.countVisits === false) void ardia.toolbar.update("showcase", { label: null });
    }
  });
})();
