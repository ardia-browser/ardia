extension WebKitExtensionShimNamespace {
  static let storage = WebKitExtensionShimNamespace(name: "storage", inContentScripts: true, script: #"""
      if (APIS.includes("storage")) {
        const readOnly = withCallback(() => failure("This is a read-only store."));
        const changed = event("storage", "onManagedChanged");
        const managed = {
          get: withCallback((keys) => request("storage", "managedGet", [keys === undefined ? null : keys])),
          getBytesInUse: withCallback((keys) => request("storage", "managedBytesInUse", [keys === undefined ? null : keys])),
          getKeys: withCallback(async () => Object.keys(await request("storage", "managedGet", [null]))),
          set: readOnly,
          remove: readOnly,
          clear: readOnly,
          setAccessLevel: readOnly,
          onChanged: changed,
        };
        const storage = root.chrome && root.chrome.storage ? root.chrome.storage : root.browser && root.browser.storage;
        if (storage && !storage.managed) override("storage", "managed", managed);

        if (storage && SHARED.includes("storage")) {
          let unshared = false;
          const sharedChanged = event("storage", "onChanged");
          const viaEngine = async (area, method, args, fallback) => {
            if (!unshared) {
              try {
                return await direct("storage", method, [area, ...args, CONTENT]);
              } catch (error) {
                if (!isUnshared(error)) throw error;
                unshared = true;
              }
            }
            return fallback();
          };
          const both = (ours, theirs) => ({
            addListener(listener) {
              ours.addListener(listener);
              if (theirs && typeof theirs.addListener === "function") theirs.addListener(listener);
            },
            removeListener(listener) {
              ours.removeListener(listener);
              if (theirs && typeof theirs.removeListener === "function") theirs.removeListener(listener);
            },
            hasListener: (listener) => ours.hasListener(listener),
            hasListeners: () => ours.hasListeners(),
          });
          const areaEvent = (name) => {
            const wrapped = new Map();
            return {
              addListener(listener) {
                if (typeof listener !== "function" || wrapped.has(listener)) return;
                const only = (changes, areaName) => {
                  if (areaName === name) listener(changes);
                };
                wrapped.set(listener, only);
                sharedChanged.addListener(only);
              },
              removeListener(listener) {
                const only = wrapped.get(listener);
                if (!only) return;
                wrapped.delete(listener);
                sharedChanged.removeListener(only);
              },
              hasListener: (listener) => wrapped.has(listener),
              hasListeners: () => wrapped.size > 0,
            };
          };
          const area = (name) => {
            const original = storage[name];
            const call = (method, ...args) =>
              original && typeof original[method] === "function" ? settle(original[method](...args)) : failure(`storage.${name}.${method} isn't available.`);
            const shared = Object.create(original || Object.prototype);
            Object.defineProperties(shared, Object.getOwnPropertyDescriptors({
              get: withCallback((keys) => viaEngine(name, "sharedGet", [keys === undefined ? null : keys], () => call("get", keys))),
              getKeys: withCallback(() => viaEngine(name, "sharedGetKeys", [], () => call("getKeys"))),
              set: withCallback((items) => viaEngine(name, "sharedSet", [items || {}], () => call("set", items))),
              remove: withCallback((keys) => viaEngine(name, "sharedRemove", [keys === undefined ? [] : keys], () => call("remove", keys))),
              clear: withCallback(() => viaEngine(name, "sharedClear", [], () => call("clear"))),
              getBytesInUse: withCallback((keys) => viaEngine(name, "sharedBytesInUse", [keys === undefined ? null : keys], () => call("getBytesInUse", keys))),
              setAccessLevel: withCallback((options) =>
                viaEngine(name, "sharedSetAccessLevel", [options && options.accessLevel], () => call("setAccessLevel", options)),
              ),
              onChanged: both(areaEvent(name), original && original.onChanged),
            }));
            return shared;
          };
          for (const name of ["local", "sync", "session"]) override("storage", name, area(name));
          override("storage", "onChanged", both(sharedChanged, storage.onChanged));
        }
      }
    """#)
}
