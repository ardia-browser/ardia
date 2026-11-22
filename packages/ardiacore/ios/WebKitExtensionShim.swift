import Foundation

struct WebKitExtensionShimNamespace: Sendable {
  let name: String
  var permissions: Set<String> = []
  var inContentScripts = false
  let script: String

  init(name: String, permissions: Set<String>? = nil, inContentScripts: Bool = false, script: String) {
    self.name = name
    self.permissions = permissions ?? [name]
    self.inContentScripts = inContentScripts
    self.script = script
  }
}

enum WebKitExtensionShim {
  static let fileName = "__ardia_webkit_shim.js"
  static let application = "dev.ardia.webkit"
  static let namespaces: [WebKitExtensionShimNamespace] = [
    .runtime, .commands, .downloads, .history, .bookmarks, .sidePanel, .tabGroups, .management, .idle, .topSites, .search, .sessions, .browsingData, .dns, .tts,
    .offscreen, .storage, .identity, .alarms, .declarativeNetRequest, .notifications,
  ]
  static let names = Set(namespaces.map(\.name))

  static func relayKey() -> String { "__ardiaWebKitRelay_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }

  static func source(apis: Set<String>, permissions: Set<String> = [], content: Bool = false, shared: Set<String> = [], relay: String, contentFile: String = "") -> String {
    let scripts = namespaces.filter { apis.contains($0.name) }.map { $0.script.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n      ")
    return template.replacingOccurrences(of: "__ARDIA_APP__", with: "\"\(application)\"").replacingOccurrences(of: "__ARDIA_APIS__", with: json(apis))
      .replacingOccurrences(of: "__ARDIA_PERMISSIONS__", with: json(permissions)).replacingOccurrences(of: "__ARDIA_CONTENT__", with: content ? "true" : "false")
      .replacingOccurrences(of: "__ARDIA_SHARED__", with: json(shared))
      .replacingOccurrences(of: "__ARDIA_RELAY__", with: "\"\(relay)\"")
      .replacingOccurrences(of: "__ARDIA_CONTENT_FILE__", with: "\"\(contentFile)\"")
      .replacingOccurrences(of: "__ARDIA_NAMESPACES__", with: scripts)
  }

  static func contentApis(_ apis: Set<String>) -> Set<String> { Set(namespaces.filter { $0.inContentScripts && apis.contains($0.name) }.map(\.name)) }

  static func staged(granted: Set<String>) -> Set<String> {
    Set(namespaces.filter { namespace in namespace.permissions.isEmpty || !namespace.permissions.isDisjoint(with: granted) }.map(\.name))
  }

  private static func json(_ values: Set<String>) -> String {
    (try? JSONSerialization.data(withJSONObject: values.sorted())).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
  }

  static let template = #"""
    (() => {
      const root = globalThis;
      if (root.__ardiaWebKitShim) return;
      Object.defineProperty(root, "__ardiaWebKitShim", { value: true });
      const ns = root.browser || root.chrome;
      const runtime = ns && ns.runtime;
      const NATIVE = !!runtime && typeof runtime.sendNativeMessage === "function";
      const CONTENT = __ARDIA_CONTENT__;
      if (!runtime || (!NATIVE && !CONTENT)) return;
      const APP = __ARDIA_APP__;
      const APIS = __ARDIA_APIS__;
      const PERMISSIONS = __ARDIA_PERMISSIONS__;
      const SHARED = __ARDIA_SHARED__;
      const UNSHARED = "__ardia_unshared__";
      const BACKGROUND = !!root.__ardiaWebKitBackground;
      const BACKGROUND_PATH = typeof root.__ardiaWebKitBackground === "string" ? root.__ardiaWebKitBackground : "";
      const RELAY = __ARDIA_RELAY__;
      const CONTENT_FILE = __ARDIA_CONTENT_FILE__;
      const CONTEXT = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const nativeSend = NATIVE ? runtime.sendNativeMessage.bind(runtime) : null;
      const runtimeSend = typeof runtime.sendMessage === "function" ? runtime.sendMessage.bind(runtime) : null;
      const nativeConnect = NATIVE && typeof runtime.connectNative === "function" ? runtime.connectNative.bind(runtime) : null;
      const relayConnect = !NATIVE && CONTENT && typeof runtime.connect === "function" ? runtime.connect.bind(runtime) : null;
      const CALLS = `${RELAY}:call`;
      const relayCalls = new Map();
      let callPort = null;
      let lastCall = 0;
      const relayCall = (message) =>
        new Promise((resolve, reject) => {
          if (!relayConnect) return reject(new Error("Ardia can't be reached from here."));
          if (!callPort) {
            try {
              callPort = relayConnect({ name: CALLS });
            } catch (error) {
              return reject(error);
            }
            callPort.onMessage.addListener((answer) => {
              const waiting = answer && relayCalls.get(answer.answer);
              if (!waiting) return;
              relayCalls.delete(answer.answer);
              waiting.resolve(answer.reply);
            });
            callPort.onDisconnect.addListener(() => {
              callPort = null;
              const left = [...relayCalls.values()];
              relayCalls.clear();
              for (const waiting of left) waiting.reject(new Error("Ardia's relay closed."));
            });
          }
          lastCall += 1;
          relayCalls.set(lastCall, { resolve, reject });
          callPort.postMessage({ call: lastCall, message });
        });
      const send = (application, message) => (nativeSend ? nativeSend(application, message) : relayCall(message));
      const connect = nativeConnect || (relayConnect ? () => relayConnect({ name: RELAY }) : null);
      const tabsApi = ns.tabs;
      const windowsApi = ns.windows;
      const bound = (object, name) => (object && typeof object[name] === "function" ? object[name].bind(object) : null);
      const tabsGet = bound(tabsApi, "get");
      const tabsQuery = bound(tabsApi, "query");
      const windowsGetAll = bound(windowsApi, "getAll");
      const windowsGetCurrent = bound(windowsApi, "getCurrent");
      const settle = (value) => Promise.resolve(value);

      const windowIds = async () => {
        if (!windowsGetAll) return [];
        try {
          return (await settle(windowsGetAll({}))).map((w) => w.id);
        } catch (error) {
          return [];
        }
      };
      const currentWindow = async () => {
        if (!windowsGetCurrent) return -1;
        try {
          return (await settle(windowsGetCurrent({}))).id;
        } catch (error) {
          return -1;
        }
      };
      const describeTab = (tab, order) => ({ window: order.indexOf(tab.windowId), index: tab.index, url: tab.url || tab.pendingUrl || "" });

      const prepare = async (args) => {
        const order = await windowIds();
        const refs = [];
        const tabRef = async (id) => {
          if (typeof id !== "number" || !tabsGet) return -1;
          try {
            refs.push(describeTab(await settle(tabsGet(id)), order));
          } catch (error) {
            refs.push(null);
          }
          return refs.length - 1;
        };
        const windowRef = async (id) => {
          if (typeof id !== "number") return -1;
          return order.indexOf(id === -2 ? await currentWindow() : id);
        };
        const prepared = [];
        for (const arg of args) {
          if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
            prepared.push(arg);
            continue;
          }
          const copy = Object.assign({}, arg);
          if ("tabId" in copy) copy.tabId = { __tab: await tabRef(copy.tabId) };
          if ("tabIds" in copy) {
            const ids = Array.isArray(copy.tabIds) ? copy.tabIds : [copy.tabIds];
            const marked = [];
            for (const id of ids) marked.push({ __tab: await tabRef(id) });
            copy.tabIds = marked;
          }
          if ("windowId" in copy) copy.windowId = { __window: await windowRef(copy.windowId) };
          if (copy.createProperties && typeof copy.createProperties === "object" && "windowId" in copy.createProperties) {
            copy.createProperties = Object.assign({}, copy.createProperties, { windowId: { __window: await windowRef(copy.createProperties.windowId) } });
          }
          prepared.push(copy);
        }
        return { args: prepared, tabs: refs };
      };

      const placeWindows = async (value, windows) => {
        if (!value || typeof value !== "object") return value;
        const order = await windowIds();
        const ordinal = (keys) => (windows || []).findIndex((list) => Array.isArray(list) && list.some((key) => keys.includes(key)));
        const visit = (item) => {
          if (Array.isArray(item)) return item.map(visit);
          if (!item || typeof item !== "object") return item;
          if (Array.isArray(item.__windowTabs)) {
            const at = ordinal(item.__windowTabs);
            return at >= 0 && at < order.length ? order[at] : -1;
          }
          const out = {};
          for (const [key, inner] of Object.entries(item)) out[key] = visit(inner);
          return out;
        };
        return visit(value);
      };

      const activated = () => !CONTENT && !BACKGROUND && !!(root.navigator && root.navigator.userActivation && root.navigator.userActivation.isActive);
      const request = async (api, method, args) => {
        const activation = activated();
        const prepared = await prepare(args);
        const reply = await settle(send(APP, { ardia: 1, api, method, args: prepared.args, tabs: prepared.tabs, context: CONTEXT, activation }));
        if (!reply || typeof reply !== "object") throw new Error(`Ardia didn't answer ${api}.${method}.`);
        if (typeof reply.error === "string") throw new Error(reply.error);
        return reply.result === null ? undefined : placeWindows(reply.result, reply.windows);
      };

      const direct = async (api, method, args) => {
        const reply = await settle(send(APP, { ardia: 1, api, method, args, tabs: [], context: CONTEXT }));
        if (!reply || typeof reply !== "object") throw new Error(`Ardia didn't answer ${api}.${method}.`);
        if (typeof reply.error === "string") throw new Error(reply.error);
        return reply.result === null ? undefined : reply.result;
      };
      const isUnshared = (error) => !!error && error.message === UNSHARED;

      const withCallback = (run) =>
        function (...args) {
          const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
          const done = run(...args);
          if (!callback) return done;
          done.then(
            (value) => callback(value),
            (error) => {
              console.error(error);
              callback();
            },
          );
          return undefined;
        };

      const listeners = new Map();
      const holds = new Map();
      const signals = new Map();
      let port = null;
      let retry = null;
      const listened = () =>
        [...new Set([...[...listeners].filter(([, set]) => set.size).map(([key]) => key.split(".")[0]), ...[...holds].filter(([, n]) => n > 0).map(([api]) => api)])];
      const post = (message) => {
        if (port) port.postMessage(Object.assign({ ardia: 1 }, message));
        return !!port;
      };
      const hold = (api, on) => {
        holds.set(api, Math.max(0, (holds.get(api) || 0) + (on ? 1 : -1)));
        announce();
      };
      const dispatch = async (message) => {
        if (!message || message.ardia !== 1) return;
        if (typeof message.signal === "string") {
          const handler = signals.get(message.signal);
          if (handler) handler(message);
          return;
        }
        if (typeof message.api !== "string") return;
        const set = listeners.get(`${message.api}.${message.event}`);
        if (!set || !set.size) return;
        const args = await placeWindows(Array.isArray(message.args) ? message.args : [], message.windows);
        for (const listener of [...set]) {
          try {
            listener(...args);
          } catch (error) {
            console.error(error);
          }
        }
      };
      const announce = () => {
        const apis = listened();
        if (!port && apis.length && connect) {
          try {
            port = connect(APP);
            port.onMessage.addListener(dispatch);
            port.onDisconnect.addListener(() => {
              port = null;
              if (listened().length && !retry) retry = setTimeout(() => ((retry = null), announce()), 1000);
            });
          } catch (error) {
            port = null;
          }
        }
        if (port) port.postMessage({ ardia: 1, listen: apis, context: CONTEXT });
      };
      const event = (api, name) => {
        const key = `${api}.${name}`;
        return {
          addListener(listener) {
            if (typeof listener !== "function") return;
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key).add(listener);
            announce();
          },
          removeListener(listener) {
            const set = listeners.get(key);
            if (set && set.delete(listener)) announce();
          },
          hasListener(listener) {
            const set = listeners.get(key);
            return !!set && set.has(listener);
          },
          hasListeners() {
            const set = listeners.get(key);
            return !!set && set.size > 0;
          },
        };
      };
      const api = (name, methods, events, extra) => {
        const object = Object.assign({}, extra || {});
        for (const method of methods) object[method] = withCallback((...args) => request(name, method, args));
        for (const e of events) object[e] = event(name, e);
        return object;
      };
      const define = (name, object) => {
        if (!APIS.includes(name)) return;
        for (const target of new Set([root.chrome, root.browser])) {
          if (!target || target[name]) continue;
          try {
            Object.defineProperty(target, name, { value: object, configurable: true, enumerable: true, writable: true });
          } catch (error) {}
        }
      };
      const viewRoots = [...new Set([root.chrome, root.browser])].filter(Boolean);
      const viewed = new Map();
      const viewPaths = new Set();
      const views = new WeakMap();
      const boundMethods = new WeakMap();
      const methodOf = (target, value) => {
        let made = boundMethods.get(target);
        if (!made) boundMethods.set(target, (made = new WeakMap()));
        let bound = made.get(value);
        if (!bound) made.set(value, (bound = value.bind(target)));
        return bound;
      };
      const viewAt = (object, path) => {
        let made = views.get(object);
        if (!made) views.set(object, (made = new Map()));
        if (made.has(path)) return made.get(path);
        const overrides = () => viewed.get(path);
        const view = new Proxy(Object.create(null), {
          get(_, name) {
            const here = overrides();
            if (here && here.has(name)) return here.get(name);
            const value = Reflect.get(object, name);
            const below = typeof name === "string" ? (path ? `${path}.${name}` : name) : null;
            if (below !== null && value && (typeof value === "object" || typeof value === "function") && viewPaths.has(below)) return viewAt(value, below);
            return typeof value === "function" ? methodOf(object, value) : value;
          },
          set: (_, name, value) => Reflect.set(object, name, value),
          has(_, name) {
            const here = overrides();
            return !!(here && here.has(name)) || Reflect.has(object, name);
          },
          deleteProperty: (_, name) => Reflect.deleteProperty(object, name),
          defineProperty: (_, name, descriptor) => Reflect.defineProperty(object, name, descriptor),
          getPrototypeOf: () => Reflect.getPrototypeOf(object),
          ownKeys() {
            const here = overrides();
            return [...new Set([...Reflect.ownKeys(object), ...(here ? here.keys() : [])])];
          },
          getOwnPropertyDescriptor(_, name) {
            const here = overrides();
            if (here && here.has(name)) return { value: here.get(name), writable: true, enumerable: true, configurable: true };
            const found = Reflect.getOwnPropertyDescriptor(object, name);
            return found ? { ...found, configurable: true } : undefined;
          },
        });
        made.set(path, view);
        return view;
      };
      const showViews = () => {
        for (const native of viewRoots) {
          const view = viewAt(native, "");
          if (root.chrome !== native || root.chrome === view) continue;
          try {
            Object.defineProperty(root, "chrome", { value: view, configurable: true, enumerable: true, writable: true });
          } catch (error) {}
        }
      };
      const patch = (target, name, value, path) => {
        if (!target) return false;
        try {
          Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
        } catch (error) {
          try {
            target[name] = value;
          } catch (inner) {}
        }
        const took = target[name] === value;
        if (typeof path !== "string" || !viewRoots.length) return took;
        if (!viewed.has(path)) viewed.set(path, new Map());
        viewed.get(path).set(name, value);
        const parts = path ? path.split(".") : [];
        for (let i = 1; i <= parts.length; i += 1) viewPaths.add(parts.slice(0, i).join("."));
        showViews();
        return true;
      };
      const kept = new Set();
      const override = (namespace, name, value) => {
        for (const target of new Set([root.chrome, root.browser])) {
          const original = target && target[namespace];
          if (!original) continue;
          kept.add(original);
          patch(original, name, value, namespace);
          const shared = Object.getPrototypeOf(original);
          if (shared && shared !== Object.prototype && shared !== Function.prototype) patch(shared, name, value);
        }
      };
      const granted = (permission) => PERMISSIONS.includes(permission);
      const failure = (message) => Promise.reject(new Error(message));
      const fromContent = (message, sender) =>
        Object.assign({}, message && typeof message === "object" && !Array.isArray(message) ? message : {}, {
          relayed: true,
          relayedFrom: { url: sender && typeof sender.url === "string" ? sender.url : "", origin: sender && typeof sender.origin === "string" ? sender.origin : "" },
        });

      if (BACKGROUND && nativeConnect && runtime.onConnect && typeof runtime.onConnect.addListener === "function") {
        const onConnect = runtime.onConnect;
        const add = onConnect.addListener.bind(onConnect);
        const remove = typeof onConnect.removeListener === "function" ? onConnect.removeListener.bind(onConnect) : null;
        const has = typeof onConnect.hasListener === "function" ? onConnect.hasListener.bind(onConnect) : null;
        const wrapped = new WeakMap();
        const calling = (port) => !!port && port.name === CALLS;
        const relayed = (port) => !!port && (port.name === RELAY || port.name === CALLS);
        const quietly = (run) => {
          try {
            run();
          } catch (error) {}
        };
        add((port) => {
          if (!relayed(port) || !port.sender || port.sender.id !== runtime.id) return;
          if (calling(port)) {
            port.onMessage.addListener((asked) => {
              if (!asked || typeof asked.call !== "number") return;
              settle(nativeSend(APP, fromContent(asked.message, port.sender)))
                .then(
                  (reply) => reply,
                  (error) => ({ error: String((error && error.message) || error) }),
                )
                .then((reply) => quietly(() => port.postMessage({ answer: asked.call, reply })));
            });
            return;
          }
          let upstream = null;
          try {
            upstream = nativeConnect(APP);
          } catch (error) {
            port.disconnect();
            return;
          }
          upstream.onMessage.addListener((message) => quietly(() => port.postMessage(message)));
          upstream.onDisconnect.addListener(() => quietly(() => port.disconnect()));
          port.onMessage.addListener((message) => quietly(() => upstream.postMessage(fromContent(message, port.sender))));
          port.onDisconnect.addListener(() => quietly(() => upstream.disconnect()));
        });
        const guard = (listener) => {
          if (typeof listener !== "function") return listener;
          if (!wrapped.has(listener)) wrapped.set(listener, (port) => (relayed(port) ? undefined : listener(port)));
          return wrapped.get(listener);
        };
        patch(onConnect, "addListener", (listener) => add(guard(listener)), "runtime.onConnect");
        if (remove) patch(onConnect, "removeListener", (listener) => remove(wrapped.get(listener) || listener), "runtime.onConnect");
        if (has) patch(onConnect, "hasListener", (listener) => has(wrapped.get(listener) || listener), "runtime.onConnect");
      }

      if (!CONTENT && CONTENT_FILE) {
        const own = (file) => String(file || "").replace(/^\/+/, "") === CONTENT_FILE;
        const isolated = (entry) => !!entry && typeof entry === "object" && entry.world !== "MAIN";
        const withShim = (entry) =>
          isolated(entry) && Array.isArray(entry.js) && entry.js.length ? Object.assign({}, entry, { js: [CONTENT_FILE, ...entry.js.filter((file) => !own(file))] }) : entry;
        const scriptingApi = ns.scripting;
        const register = bound(scriptingApi, "registerContentScripts");
        const update = bound(scriptingApi, "updateContentScripts");
        const execute = bound(scriptingApi, "executeScript");
        if (register) override("scripting", "registerContentScripts", (scripts, ...rest) => register(Array.isArray(scripts) ? scripts.map(withShim) : scripts, ...rest));
        if (update) override("scripting", "updateContentScripts", (scripts, ...rest) => update(Array.isArray(scripts) ? scripts.map(withShim) : scripts, ...rest));
        if (execute) {
          override("scripting", "executeScript", (injection, ...rest) => {
            if (!isolated(injection)) return execute(injection, ...rest);
            if (Array.isArray(injection.files) && injection.files.length) {
              return execute(Object.assign({}, injection, { files: [CONTENT_FILE, ...injection.files.filter((file) => !own(file))] }), ...rest);
            }
            const callback = typeof rest[rest.length - 1] === "function" ? rest.pop() : null;
            const done = settle(execute({ target: injection.target, files: [CONTENT_FILE], injectImmediately: injection.injectImmediately }))
              .catch(() => undefined)
              .then(() => execute(injection));
            if (!callback) return done;
            done.then(callback, (error) => {
              console.error(error);
              callback();
            });
            return undefined;
          });
        }
        const tabsExecute = bound(tabsApi, "executeScript");
        if (tabsExecute) {
          override("tabs", "executeScript", (...args) => {
            const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
            const tabId = typeof args[0] === "number" ? args.shift() : undefined;
            const details = args[0] && typeof args[0] === "object" ? args[0] : {};
            const within = (extra) => (tabId === undefined ? [extra] : [tabId, extra]);
            const shim = { file: `/${CONTENT_FILE}`, runAt: "document_start" };
            for (const key of ["allFrames", "frameId", "matchAboutBlank"]) if (key in details) shim[key] = details[key];
            const done = settle(tabsExecute(...within(shim)))
              .catch(() => undefined)
              .then(() => tabsExecute(...within(details)));
            if (!callback) return done;
            done.then(callback, (error) => {
              console.error(error);
              callback();
            });
            return undefined;
          });
        }
      }

      __ARDIA_NAMESPACES__
    })();
    """#
}
