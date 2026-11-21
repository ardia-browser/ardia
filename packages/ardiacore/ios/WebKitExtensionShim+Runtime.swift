extension WebKitExtensionShimNamespace {
  static let runtime = WebKitExtensionShimNamespace(name: "runtime", permissions: [], inContentScripts: true, script: #"""
      if (APIS.includes("runtime")) {
        const ownId = runtime.id;
        const here = () => {
          const href = root.location ? String(root.location.href) : "";
          const page = BACKGROUND_PATH && /\/__ardia_webkit_worker\.js$/.test(href) ? href.replace(/__ardia_webkit_worker\.js$/, BACKGROUND_PATH) : href;
          return page.replace(/^webkit-extension:\/\/[^/]+/, `chrome-extension://${ownId}`);
        };
        const originOf = (url) => {
          const match = /^([a-z-]+:\/\/[^/]+)/i.exec(url);
          return match ? match[1] : "";
        };
        const self = () => {
          const url = here();
          return { url, origin: originOf(url), content: CONTENT };
        };
        const isExternal = (target) => typeof target === "string" && target.length > 0 && target !== ownId;
        const localEvent = () => {
          const set = new Set();
          return {
            set,
            addListener: (listener) => typeof listener === "function" && set.add(listener),
            removeListener: (listener) => set.delete(listener),
            hasListener: (listener) => set.has(listener),
            hasListeners: () => set.size > 0,
            fire: (...args) => {
              for (const listener of [...set]) {
                try {
                  listener(...args);
                } catch (error) {
                  console.error(error);
                }
              }
            },
          };
        };
        const portFor = (channel, name, sender, close) => {
          let open = true;
          const onMessage = localEvent();
          const onDisconnect = localEvent();
          const port = {
            name: name || "",
            onMessage: { addListener: onMessage.addListener, removeListener: onMessage.removeListener, hasListener: onMessage.hasListener, hasListeners: onMessage.hasListeners },
            onDisconnect: { addListener: onDisconnect.addListener, removeListener: onDisconnect.removeListener, hasListener: onDisconnect.hasListener, hasListeners: onDisconnect.hasListeners },
            postMessage(message) {
              if (!open) throw new Error("Attempting to use a disconnected port object");
              request("runtime", "portPost", [channel, message === undefined ? null : message]).catch(() => {});
            },
            disconnect() {
              if (!open) return;
              open = false;
              close(channel);
              request("runtime", "portClose", [channel]).catch(() => {});
            },
          };
          if (sender) port.sender = sender;
          return {
            port,
            deliver: (message) => open && onMessage.fire(message, port),
            end: () => {
              if (!open) return;
              open = false;
              close(channel);
              onDisconnect.fire(port);
            },
          };
        };
        const channels = new Map();
        const closeChannel = (channel) => {
          if (channels.delete(channel)) hold("runtime", false);
        };
        const openChannel = (channel, name, sender) => {
          const made = portFor(channel, name, sender, closeChannel);
          channels.set(channel, made);
          hold("runtime", true);
          return made.port;
        };
        signals.set("portMessage", (message) => {
          const channel = channels.get(message.channel);
          if (channel) channel.deliver(message.message);
        });
        signals.set("portDisconnect", (message) => {
          const channel = channels.get(message.channel);
          if (channel) channel.end();
        });

        if (!CONTENT) {
          const externalMessage = event("runtime", "onMessageExternal");
          const externalConnect = event("runtime", "onConnectExternal");
          const adapted = new WeakMap();
          const answering = (listener, replies) => {
            if (!replies || typeof listener !== "function") return listener;
            if (!adapted.has(listener)) {
              adapted.set(listener, (message, sender) =>
                new Promise((resolve) => {
                  let done = false;
                  const respond = (value) => {
                    if (done) return;
                    done = true;
                    resolve(value);
                  };
                  let kept = false;
                  try {
                    kept = listener(message, sender, respond) === true;
                  } catch (error) {
                    console.error(error);
                  }
                  if (!kept && !done) resolve(undefined);
                }),
              );
            }
            return adapted.get(listener);
          };
          const merge = (name, ours, replies) => {
            const native = runtime[name];
            const merged = {
              addListener(listener) {
                ours.addListener(listener);
                if (native && typeof native.addListener === "function") native.addListener(answering(listener, replies));
              },
              removeListener(listener) {
                ours.removeListener(listener);
                if (native && typeof native.removeListener === "function") native.removeListener(adapted.get(listener) || listener);
              },
              hasListener: (listener) => ours.hasListener(listener),
              hasListeners: () => ours.hasListeners(),
            };
            if (patch(runtime, name, merged, "runtime")) return;
            if (!native) return;
            const add = typeof native.addListener === "function" ? native.addListener.bind(native) : () => {};
            const remove = typeof native.removeListener === "function" ? native.removeListener.bind(native) : () => {};
            patch(native, "addListener", (listener) => (ours.addListener(listener), add(answering(listener, replies))), `runtime.${name}`);
            patch(native, "removeListener", (listener) => (ours.removeListener(listener), remove(adapted.get(listener) || listener)), `runtime.${name}`);
            patch(native, "hasListener", (listener) => ours.hasListener(listener), `runtime.${name}`);
          };
          merge("onMessageExternal", externalMessage, true);
          merge("onConnectExternal", externalConnect, false);
          signals.set("message", (message) => {
            const set = listeners.get("runtime.onMessageExternal");
            let answered = false;
            let waiting = false;
            const answer = (response) => {
              if (answered) return;
              answered = true;
              post({ reply: message.request, responded: true, response: response === undefined ? null : response });
            };
            for (const listener of set ? [...set] : []) {
              try {
                if (listener(message.message, message.sender, answer) === true) waiting = true;
              } catch (error) {
                console.error(error);
              }
            }
            if (!answered && !waiting) post({ reply: message.request, responded: false, listened: !!set && set.size > 0 });
          });
          signals.set("connect", (message) => {
            const set = listeners.get("runtime.onConnectExternal");
            if (!set || !set.size) return post({ reply: message.request, responded: false, listened: false });
            const port = openChannel(message.channel, message.name, message.sender);
            post({ reply: message.request, responded: true, response: null });
            for (const listener of [...set]) {
              try {
                listener(port);
              } catch (error) {
                console.error(error);
              }
            }
          });

          override("runtime", "openOptionsPage", withCallback(() => request("runtime", "openOptionsPage", [])));
          patch(runtime, "setUninstallURL", withCallback(() => Promise.resolve()), "runtime");

          const installed = runtime.onInstalled;
          if (installed && typeof installed.addListener === "function") {
            const add = installed.addListener.bind(installed);
            const remove = typeof installed.removeListener === "function" ? installed.removeListener.bind(installed) : null;
            const has = typeof installed.hasListener === "function" ? installed.hasListener.bind(installed) : null;
            const manifest = typeof runtime.getManifest === "function" ? runtime.getManifest() : null;
            const version = (manifest && manifest.version) || "";
            const asUpdates = new WeakMap();
            const asUpdate = (listener) => {
              if (typeof listener !== "function") return listener;
              if (!asUpdates.has(listener)) {
                asUpdates.set(listener, (details) =>
                  listener(details && details.reason === "install" ? Object.assign({}, details, { reason: "update", previousVersion: version }) : details),
                );
              }
              return asUpdates.get(listener);
            };
            patch(installed, "addListener", (listener) => add(asUpdate(listener)), "runtime.onInstalled");
            if (remove) patch(installed, "removeListener", (listener) => remove(asUpdates.get(listener) || listener), "runtime.onInstalled");
            if (has) patch(installed, "hasListener", (listener) => has(asUpdates.get(listener) || listener), "runtime.onInstalled");
          }
        }

        if (runtimeSend) {
          patch(runtime, "sendMessage", function (...args) {
            const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
            const target = args.length >= 2 && (typeof args[0] === "string" || args[0] == null) ? args[0] : null;
            if (!isExternal(target)) return callback ? runtimeSend(...args, callback) : runtimeSend(...args);
            const done = request("runtime", "sendExternal", [target, args[1] === undefined ? null : args[1], self()]);
            if (!callback) return done;
            done.then(callback, (error) => {
              console.error(error);
              callback();
            });
            return undefined;
          }, "runtime");
        }
        const runtimeConnect = typeof runtime.connect === "function" ? runtime.connect.bind(runtime) : null;
        if (runtimeConnect && !CONTENT) {
          patch(runtime, "connect", function (...args) {
            const target = typeof args[0] === "string" ? args[0] : null;
            if (!isExternal(target)) return runtimeConnect(...args);
            const info = (args[1] && typeof args[1] === "object" ? args[1] : {}) || {};
            const channel = `${ownId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
            const port = openChannel(channel, info.name, null);
            request("runtime", "connectExternal", [target, info.name || "", channel, self()]).catch(() => {
              const made = channels.get(channel);
              if (made) made.end();
            });
            return port;
          }, "runtime");
        }
      }
    """#)
}
