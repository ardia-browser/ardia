extension WebKitExtensionShimNamespace {
  static let declarativeNetRequest = WebKitExtensionShimNamespace(name: "declarativeNetRequest", permissions: ["declarativeNetRequest", "declarativeNetRequestWithHostAccess"], script: #"""
      if (APIS.includes("declarativeNetRequest") && SHARED.includes("dnr") && !CONTENT && ns.declarativeNetRequest) {
        const dnrApi = ns.declarativeNetRequest;
        const native = {};
        for (const method of ["getDynamicRules", "getSessionRules", "getEnabledRulesets", "getDisabledRuleIds", "updateDynamicRules", "updateSessionRules", "updateEnabledRulesets", "updateStaticRules"]) {
          native[method] = bound(dnrApi, method);
        }
        const call = (method, ...args) => (native[method] ? settle(native[method](...args)) : Promise.resolve(undefined));
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const byId = (rules) => [...(rules || [])].sort((x, y) => x.id - y.id);
        const applied = async (run) => {
          try {
            await run();
            return true;
          } catch (error) {
            console.error(error);
            direct("declarativeNetRequest", "noteApplyFailure", []).catch(() => {});
            return false;
          }
        };
        let stopped = false;
        let running = Promise.resolve();
        const replace = async (getter, updater, wanted) => {
          const now = byId(await call(getter));
          if (same(now, byId(wanted))) return;
          await call(updater, { removeRuleIds: now.map((rule) => rule.id), addRules: wanted });
        };
        const disabled = async (wanted) => {
          if (!native.getDisabledRuleIds || !native.updateStaticRules) return;
          for (const [rulesetId, ids] of Object.entries(wanted)) {
            const now = (await call("getDisabledRuleIds", { rulesetId })) || [];
            const disableRuleIds = ids.filter((id) => !now.includes(id));
            const enableRuleIds = now.filter((id) => !ids.includes(id));
            if (disableRuleIds.length || enableRuleIds.length) await call("updateStaticRules", { rulesetId, disableRuleIds, enableRuleIds });
          }
        };
        const mirror = async (kinds) => {
          if (stopped) return true;
          let state;
          try {
            state = await direct("declarativeNetRequest", "mirrorState", [kinds.includes("rulesets") ? [...new Set([...kinds, "disabled"])] : kinds]);
          } catch (error) {
            if (isUnshared(error)) {
              stopped = true;
              if (BACKGROUND) hold("declarativeNetRequest", false);
            }
            return false;
          }
          if (!state) return true;
          let ok = true;
          if (Array.isArray(state.dynamic)) ok = (await applied(() => replace("getDynamicRules", "updateDynamicRules", state.dynamic))) && ok;
          if (Array.isArray(state.session)) ok = (await applied(() => replace("getSessionRules", "updateSessionRules", state.session))) && ok;
          if (Array.isArray(state.rulesets)) {
            ok = (await applied(async () => {
              const now = (await call("getEnabledRulesets")) || [];
              const enableRulesetIds = state.rulesets.filter((id) => !now.includes(id));
              const disableRulesetIds = now.filter((id) => !state.rulesets.includes(id));
              if (enableRulesetIds.length || disableRulesetIds.length) await call("updateEnabledRulesets", { enableRulesetIds, disableRulesetIds });
            })) && ok;
          }
          if (state.disabled && typeof state.disabled === "object") ok = (await applied(() => disabled(state.disabled))) && ok;
          return ok;
        };
        const queue = (kinds) => {
          running = running.then(() => mirror(kinds)).catch((error) => (console.error(error), false));
          return running;
        };
        const writes = { updateDynamicRules: "dynamic", updateSessionRules: "session", updateEnabledRulesets: "rulesets", updateStaticRules: "static" };
        for (const [method, kind] of Object.entries(writes)) {
          if (!native[method]) continue;
          override(
            "declarativeNetRequest",
            method,
            withCallback(async (options) => {
              if (!stopped) {
                try {
                  await direct("declarativeNetRequest", "update", [kind, options && typeof options === "object" ? options : {}]);
                  if (!BACKGROUND) {
                    const applied = await direct("declarativeNetRequest", "wakeMirror", [kind === "static" ? ["rulesets", "disabled"] : [kind]]).catch(() => true);
                    if (applied === false) throw new Error("WebKit couldn't apply the updated rules; Chromium kept them and WebKit tries again on the next change.");
                    return undefined;
                  }
                  if (!(await queue(kind === "static" ? ["rulesets"] : [kind]))) throw new Error("WebKit couldn't apply the updated rules; Chromium kept them and WebKit tries again on the next change.");
                  return undefined;
                } catch (error) {
                  if (!isUnshared(error)) throw error;
                  stopped = true;
                  if (BACKGROUND) hold("declarativeNetRequest", false);
                }
              }
              return call(method, options);
            }),
          );
        }
        if (BACKGROUND) {
          signals.set("dnrChanged", (message) => {
            const done = queue(Array.isArray(message.kinds) ? message.kinds : ["dynamic", "session", "rulesets"]);
            if (message.acknowledge) done.then((applied) => direct("declarativeNetRequest", "mirrored", [applied !== false]).catch(() => {}));
          });
          hold("declarativeNetRequest", true);
          queue(["dynamic", "session", "rulesets"]);
        }
      }
    """#)
}
