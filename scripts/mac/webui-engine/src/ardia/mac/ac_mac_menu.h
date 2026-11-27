#ifndef ARDIA_MAC_AC_MAC_MENU_H_
#define ARDIA_MAC_AC_MAC_MENU_H_

#include <optional>
#include <string>
#include <vector>

#include "ardia/mac/ac_mac_menu_model.h"
#include "ardia/mac/ac_mac_menu_state.h"
#include "base/functional/callback.h"
#include "base/values.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/native_ui_types.h"

namespace ardia_mac {

struct MenuChoice {
  std::string command;
  std::string argument;
};

using MenuCommandHandler = base::RepeatingCallback<void(const MenuChoice&)>;
using ContextMenuDone = base::OnceCallback<void(std::optional<MenuChoice>)>;
using LiveMenuView = base::OnceCallback<gfx::NativeView()>;
using MenuWindowResolver = base::RepeatingCallback<std::optional<std::string>(gfx::NativeWindow)>;

struct ParsedMenu {
  menu::Item root;
  std::vector<menu::Problem> problems;
};

ParsedMenu ParseMenu(const base::Value& spec);
std::optional<menu::State> ParseMenuState(const base::Value& update);
std::optional<menu::Bookmarks> ParseMenuBookmarks(const base::Value& update);

void InstallMainMenu(const menu::Item& root, MenuCommandHandler handler);
void InstallDefaultMainMenu(MenuCommandHandler handler);
void SetMenuWindowResolver(MenuWindowResolver resolver);
void SetWindowMainMenu(const std::string& window_id, menu::Item root, MenuCommandHandler handler);
std::optional<std::string> SetWindowMenuState(const std::string& window_id, const base::Value& update);
std::optional<std::string> SetWindowMenuBookmarks(const std::string& window_id, const base::Value& update);
void ForgetWindowMenu(const std::string& window_id);
void SetMenuKeysSuppressed(const std::string& window_id, bool suppressed);
bool MenuKeysSuppressed();
std::optional<std::string> KeyMenuWindowId();

void ShowContextMenu(LiveMenuView live_view,
                     const gfx::Point& point,
                     const menu::Item& root,
                     bool background_instance,
                     ContextMenuDone done);

}

#endif
