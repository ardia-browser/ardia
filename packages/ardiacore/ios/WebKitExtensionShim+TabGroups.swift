extension WebKitExtensionShimNamespace {
  static let tabGroups = WebKitExtensionShimNamespace(name: "tabGroups", script: #"""
      if (APIS.includes("tabGroups")) {
        define("tabGroups", api("tabGroups", ["get", "query", "update", "move"], ["onCreated", "onUpdated", "onRemoved", "onMoved"], {
          TAB_GROUP_ID_NONE: -1,
          Color: { GREY: "grey", BLUE: "blue", RED: "red", YELLOW: "yellow", GREEN: "green", PINK: "pink", PURPLE: "purple", CYAN: "cyan", ORANGE: "orange" },
        }));
        const groupIdsOf = async (tabs) => {
          if (!tabs.length) return [];
          const order = await windowIds();
          const reply = await settle(send(APP, { ardia: 1, api: "tabGroups", method: "groupIdsOf", args: [], tabs: tabs.map((t) => describeTab(t, order)) }));
          return reply && Array.isArray(reply.result) ? reply.result : tabs.map(() => -1);
        };
        const withGroups = async (tabs) => {
          const ids = await groupIdsOf(tabs);
          return tabs.map((tab, i) => Object.assign({}, tab, { groupId: typeof ids[i] === "number" ? ids[i] : -1 }));
        };
        if (tabsApi && !tabsApi.group) {
          const tabCalls = {
            group: withCallback((options) => request("tabGroups", "group", [options || {}])),
            ungroup: withCallback((tabIds) => request("tabGroups", "ungroup", [{ tabIds }])),
          };
          if (tabsQuery) {
            tabCalls.query = withCallback(async (info) => {
              const query = Object.assign({}, info || {});
              const wanted = query.groupId;
              delete query.groupId;
              const tabs = await withGroups(await settle(tabsQuery(query)));
              return typeof wanted === "number" ? tabs.filter((t) => t.groupId === wanted) : tabs;
            });
          }
          if (tabsGet) tabCalls.get = withCallback(async (id) => (await withGroups([await settle(tabsGet(id))]))[0]);
          for (const target of new Set([root.chrome && root.chrome.tabs, root.browser && root.browser.tabs])) {
            if (!target) continue;
            for (const [name, value] of Object.entries(tabCalls)) {
              try {
                Object.defineProperty(target, name, { value, configurable: true, enumerable: true, writable: true });
              } catch (error) {}
            }
          }
        }
      }
    """#)
}
