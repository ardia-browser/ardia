extension WebKitExtensionShimNamespace {
  static let alarms = WebKitExtensionShimNamespace(name: "alarms", script: #"""
      if (APIS.includes("alarms") && SHARED.includes("alarms") && !CONTENT && ns.alarms) {
        const original = ns.alarms;
        const originalAlarm = original.onAlarm;
        const alarmListeners = new Set();
        let unshared = false;
        let holding = false;
        const holdWhileListening = () => {
          const want = !unshared && alarmListeners.size > 0;
          if (want === holding) return;
          holding = want;
          hold("alarms", want);
        };
        const fallBack = () => {
          if (unshared) return;
          unshared = true;
          holdWhileListening();
          if (originalAlarm) for (const listener of alarmListeners) originalAlarm.addListener(listener);
        };
        signals.set("alarm", (message) => {
          if (unshared || !message.alarm || typeof message.alarm !== "object") return;
          for (const listener of [...alarmListeners]) {
            try {
              listener(Object.assign({}, message.alarm));
            } catch (error) {
              console.error(error);
            }
          }
        });
        const viaEngine = async (method, args, fallback) => {
          if (!unshared) {
            try {
              return await direct("alarms", method, args);
            } catch (error) {
              if (!isUnshared(error)) throw error;
              fallBack();
            }
          }
          return fallback();
        };
        const originalCall = (method, args) => settle(original[method](...args));
        const shared = Object.create(original);
        Object.defineProperties(shared, Object.getOwnPropertyDescriptors({
          create: withCallback((...args) => {
            const named = typeof args[0] === "string" || args[0] === undefined || args[0] === null;
            const info = Object.assign({}, (named ? args[1] : args[0]) || {});
            if (named && typeof args[0] === "string" && info.name !== undefined) {
              return failure("Cannot set alarm name in both separate argument and object form.");
            }
            const name = named && typeof args[0] === "string" ? args[0] : typeof info.name === "string" ? info.name : "";
            delete info.name;
            return viaEngine("create", [name, info], () => originalCall("create", args));
          }),
          get: withCallback((name) => viaEngine("get", [typeof name === "string" ? name : ""], () => originalCall("get", name === undefined ? [] : [name]))),
          getAll: withCallback(() => viaEngine("getAll", [], () => originalCall("getAll", []))),
          clear: withCallback((name) => viaEngine("clear", [typeof name === "string" ? name : ""], () => originalCall("clear", name === undefined ? [] : [name]))),
          clearAll: withCallback(() => viaEngine("clearAll", [], () => originalCall("clearAll", []))),
          onAlarm: {
            addListener(listener) {
              if (typeof listener !== "function") return;
              alarmListeners.add(listener);
              if (unshared && originalAlarm) originalAlarm.addListener(listener);
              holdWhileListening();
            },
            removeListener(listener) {
              alarmListeners.delete(listener);
              if (originalAlarm) originalAlarm.removeListener(listener);
              holdWhileListening();
            },
            hasListener: (listener) => alarmListeners.has(listener),
            hasListeners: () => alarmListeners.size > 0,
          },
        }));
        for (const target of new Set([root.chrome, root.browser])) patch(target, "alarms", shared, "");
        if (BACKGROUND && typeof original.clearAll === "function") settle(original.clearAll()).catch(() => {});
      }
    """#)
}
