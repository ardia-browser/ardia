#ifndef ARDIA_LINUX_AC_LINUX_CONTRACT_H_
#define ARDIA_LINUX_AC_LINUX_CONTRACT_H_

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <initializer_list>

#include "ardia/desktop/generated/ac_desktop_routes.h"

namespace ardiacore::linux_contract {

enum class UnclaimedTabStep { kDrop, kWait, kPark, kReport };

inline constexpr int kUnclaimedTabBlankTries = 20;

inline UnclaimedTabStep NextUnclaimedTabStep(bool in_window, bool claimed, bool listening, bool blank, int tries) {
  if (!in_window || claimed) return UnclaimedTabStep::kDrop;
  if (blank && tries < kUnclaimedTabBlankTries) return UnclaimedTabStep::kWait;
  return listening ? UnclaimedTabStep::kReport : UnclaimedTabStep::kPark;
}

using ardia::desktop_routes::FindRoute;
using ardia::desktop_routes::kRoutes;
using ardia::desktop_routes::Route;

inline bool OwnsClaim(std::string_view active, std::string_view supplied) {
  return !active.empty() && active == supplied;
}

inline bool CanReclaim(std::string_view active, std::string_view previous) {
  return active.empty() || OwnsClaim(active, previous);
}

inline bool CanTransfer(bool offered, bool temporary, bool same_profile) {
  return offered && !temporary && same_profile;
}

inline bool ReleasedTabIsGone(bool has_binding, bool has_page) {
  return !has_binding || !has_page;
}

inline std::string_view EventName(std::string_view topic) {
  for (const auto name : {"history.changed", "history.imported", "bookmarks.changed", "extensions.action", "extensions.sync", "downloads.changed", "downloads.removed"}) {
    if (topic == name) return name;
  }
  return {};
}

inline std::string_view ChangeAnnouncedAfter(std::string_view call, std::optional<int> applied) {
  if (call == "bookmarks.apply" && applied.value_or(0) > 0) return EventName("bookmarks.changed");
  if (call == "history.import") return EventName("history.imported");
  return {};
}

}

#endif
