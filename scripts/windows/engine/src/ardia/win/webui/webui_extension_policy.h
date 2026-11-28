#ifndef ARDIA_WIN_WEBUI_WEBUI_EXTENSION_POLICY_H_
#define ARDIA_WIN_WEBUI_WEBUI_EXTENSION_POLICY_H_

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <string_view>

namespace ardia_win::webui_extension {

inline constexpr size_t kActionStatesRequestLimit = 64 * 1024;
inline constexpr double kViewCoordinateLimit = 100000.0;
inline constexpr size_t kViewIdLimit = 64;

constexpr bool ActionStatesRequestFits(std::string_view json) {
  return !json.empty() && json.size() <= kActionStatesRequestLimit &&
         json.find('\0') == std::string_view::npos;
}

inline bool ViewCoordinateInRange(double value) {
  return std::isfinite(value) && std::abs(value) <= kViewCoordinateLimit;
}

constexpr bool ViewProfileMatches(std::string_view requested,
                                  std::string_view window_profile) {
  return !requested.empty() && requested == window_profile;
}

class ViewIds {
 public:
  std::optional<int> Assign(int internal, uint64_t generation) {
    if (internal <= 0 || next_ == std::numeric_limits<int>::max()) {
      return std::nullopt;
    }
    while (ids_.size() >= kViewIdLimit) {
      ids_.erase(ids_.begin());
    }
    const int external = ++next_;
    ids_[external] = Entry{internal, generation};
    return external;
  }

  int Internal(int external) const {
    auto found = ids_.find(external);
    return found == ids_.end() ? 0 : found->second.internal;
  }

  std::optional<int> External(int internal) const {
    for (const auto& [external, entry] : ids_) {
      if (entry.internal == internal) {
        return external;
      }
    }
    return std::nullopt;
  }

  void Forget(int external) { ids_.erase(external); }

  void ForgetOlderThan(uint64_t generation) {
    for (auto it = ids_.begin(); it != ids_.end();) {
      it = it->second.generation < generation ? ids_.erase(it) : std::next(it);
    }
  }

  void Clear() { ids_.clear(); }
  size_t size() const { return ids_.size(); }

 private:
  struct Entry {
    int internal = 0;
    uint64_t generation = 0;
  };
  std::map<int, Entry> ids_;
  int next_ = 0;
};

}

#endif
