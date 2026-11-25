#ifndef ARDIA_DESKTOP_GENERATED_AC_DESKTOP_ROUTES_H_
#define ARDIA_DESKTOP_GENERATED_AC_DESKTOP_ROUTES_H_

#include <array>
#include <string_view>

namespace ardia::desktop_routes {

struct Route {
  std::string_view name;
  std::string_view service;
  std::string_view field;
};

inline constexpr std::array<Route, 37> kRoutes = {{
    {"engine.components", "ac_components_list", "components"},
    {"engine.tasks", "ac_tasks_list", "tasks"},
    {"engine.batterySaver", "ac_battery_saver", ""},
    {"engine.trimMemory", "ac_memory_trim", ""},
    {"engine.openTaskManager", "ac_task_manager_open", ""},
    {"tabs.lastTabPolicy", "ac_tabs_last_tab_policy", ""},
    {"downloads.settings", "ac_downloads_settings", ""},
    {"downloads.setSettings", "ac_downloads_set_settings", ""},
    {"downloads.cancel", "ac_downloads_command", "null"},
    {"downloads.pause", "ac_downloads_command", "null"},
    {"downloads.resume", "ac_downloads_command", "null"},
    {"downloads.keep", "ac_downloads_command", "null"},
    {"history.query", "ac_history_query", ""},
    {"history.add", "ac_history_add", ""},
    {"history.import", "ac_history_import", ""},
    {"history.deleteUrls", "ac_history_delete_urls", ""},
    {"history.watch", "ac_history_watch", ""},
    {"bookmarks.tree", "ac_bookmarks_tree", ""},
    {"bookmarks.apply", "ac_bookmarks_apply", ""},
    {"bookmarks.watch", "ac_bookmarks_watch", ""},
    {"favicons.get", "ac_favicons_get", ""},
    {"favicons.peek", "ac_favicons_peek", ""},
    {"favicons.set", "ac_favicons_set", ""},
    {"extensions.list", "ac_extensions_list", ""},
    {"extensions.install", "ac_extensions_install", ""},
    {"extensions.installCrx", "ac_extensions_install_crx", ""},
    {"extensions.setEnabled", "ac_extensions_set_enabled", ""},
    {"extensions.uninstall", "ac_extensions_uninstall", ""},
    {"extensions.reload", "ac_extensions_reload", ""},
    {"extensions.configure", "ac_extensions_configure", ""},
    {"extensions.watchActions", "ac_extensions_watch_actions", ""},
    {"extensions.syncState", "ac_extensions_sync_state", ""},
    {"extensions.syncApply", "ac_extensions_sync_apply", ""},
    {"extensions.loadHealth", "ac_extensions_load_health", ""},
    {"search.engines", "ac_search_engines_list", ""},
    {"permissions.externalAppAllowances", "ac_external_apps_allowances", "allowances"},
    {"permissions.removeExternalAppAllowance", "ac_external_apps_remove", "null"},
}};

inline constexpr const Route* FindRoute(std::string_view name) {
  for (const auto& route : kRoutes) {
    if (route.name == name) return &route;
  }
  return nullptr;
}

}

#endif
