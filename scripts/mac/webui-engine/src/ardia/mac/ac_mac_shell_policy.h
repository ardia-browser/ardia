#ifndef ARDIA_MAC_AC_MAC_SHELL_POLICY_H_
#define ARDIA_MAC_AC_MAC_SHELL_POLICY_H_

#include <cstdint>
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <utility>
#include <limits>
#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace ardia_mac::shell_policy {

inline constexpr std::size_t kDocumentNameLimit = 200;
inline constexpr std::string_view kSessionFile = "session.json";

inline char LowerAscii(char c) {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

inline bool EqualsIgnoringAsciiCase(std::string_view a, std::string_view b) {
  return a.size() == b.size() &&
         std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) { return LowerAscii(x) == LowerAscii(y); });
}

inline bool ValidDocumentName(std::string_view name) {
  if (name.empty() || name.size() > kDocumentNameLimit || name.front() == '.') return false;
  const bool charset = std::all_of(name.begin(), name.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
           c == '-';
  });
  return charset && !EqualsIgnoringAsciiCase(name, kSessionFile);
}

inline bool ReservedLiveDocument(std::string_view name) {
  return EqualsIgnoringAsciiCase(name, "live.json") || EqualsIgnoringAsciiCase(name, "live.canonical.json");
}

inline constexpr std::size_t kMergeableSessionBytes = 8 * 1024 * 1024;
inline constexpr std::string_view kSetAsideSessionPrefix = "session-backup-oversized-";

inline bool SessionFitsOnDisk(std::size_t serialized_bytes) {
  return serialized_bytes <= kMergeableSessionBytes;
}

enum class SessionFile { kAbsent, kUse, kSetAside };

inline SessionFile SessionFileFor(bool exists, std::size_t bytes, bool parsed_object, bool mergeable) {
  if (!exists) return SessionFile::kAbsent;
  if (bytes > kMergeableSessionBytes || !parsed_object || !mergeable) return SessionFile::kSetAside;
  return SessionFile::kUse;
}

inline constexpr int kSetAsideAttempts = 64;

inline std::string SetAsideSessionName(std::uint64_t unix_ms, int attempt) {
  return std::string(kSetAsideSessionPrefix) + std::to_string(unix_ms) + "-" + std::to_string(attempt) + ".json";
}

enum class SessionLoad { kAbsent, kUse, kQuarantined, kBlocked };

inline SessionLoad SessionLoadFor(SessionFile file, bool moved_aside) {
  switch (file) {
    case SessionFile::kAbsent:
      return SessionLoad::kAbsent;
    case SessionFile::kUse:
      return SessionLoad::kUse;
    case SessionFile::kSetAside:
      return moved_aside ? SessionLoad::kQuarantined : SessionLoad::kBlocked;
  }
  return SessionLoad::kBlocked;
}

inline bool SessionWritable(SessionLoad load) {
  return load != SessionLoad::kBlocked;
}
inline std::optional<int> ParseAdoptId(std::string_view adopt) {
  constexpr std::string_view prefix = "tab:";
  if (!adopt.starts_with(prefix) || adopt.size() == prefix.size() || adopt.size() > prefix.size() + 10) {
    return std::nullopt;
  }
  long long value = 0;
  for (char c : adopt.substr(prefix.size())) {
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + (c - '0');
  }
  if (value <= 0 || value > std::numeric_limits<int>::max()) return std::nullopt;
  return static_cast<int>(value);
}

inline constexpr int kUnclaimedTries = 40;

enum class UnclaimedStep { kWait, kPark, kDrop, kReport };

inline UnclaimedStep NextUnclaimedStep(bool in_window, bool claimed, bool listening, bool blank_url, int tries) {
  if (claimed) return UnclaimedStep::kDrop;
  if (!in_window) return tries < kUnclaimedTries ? UnclaimedStep::kWait : UnclaimedStep::kDrop;
  if (!listening) return UnclaimedStep::kPark;
  if (blank_url && tries < kUnclaimedTries) return UnclaimedStep::kWait;
  return UnclaimedStep::kReport;
}

enum class AdoptRefusal { kNone, kMalformed, kNotOffered, kOtherProfile, kGone, kAlreadyClaimed };

inline AdoptRefusal CheckAdoption(bool parsed, bool offered, bool same_profile, bool present, bool bound) {
  if (!parsed) return AdoptRefusal::kMalformed;
  if (!offered) return AdoptRefusal::kNotOffered;
  if (!same_profile) return AdoptRefusal::kOtherProfile;
  if (!present) return AdoptRefusal::kGone;
  if (bound) return AdoptRefusal::kAlreadyClaimed;
  return AdoptRefusal::kNone;
}

template <typename Handle>
class OfferBook {
 public:
  struct Offer {
    Handle handle;
    bool active = false;
  };

  void Add(int id, Handle handle, bool active) { offers_[id] = Offer{std::move(handle), active}; }
  void Forget(int id) { offers_.erase(id); }
  const Offer* Find(int id) const {
    const auto found = offers_.find(id);
    return found == offers_.end() ? nullptr : &found->second;
  }
  template <typename Keep>
  void Prune(Keep keep) {
    std::erase_if(offers_, [&keep](const auto& entry) { return !keep(entry.first, entry.second); });
  }
  const std::map<int, Offer>& offers() const { return offers_; }
  std::size_t size() const { return offers_.size(); }

 private:
  std::map<int, Offer> offers_;
};

enum class ShortcutAction { kDispatch, kConsume };

inline ShortcutAction ShortcutActionFor(bool suppressed) {
  return suppressed ? ShortcutAction::kConsume : ShortcutAction::kDispatch;
}

inline bool ShellTakesQuit(bool renderer_live, std::uint64_t ready_generation, std::uint64_t renderer_generation) {
  return renderer_live && ready_generation != 0 && ready_generation == renderer_generation;
}
inline constexpr int kShiftDown = 1 << 1;
inline constexpr int kControlDown = 1 << 2;
inline constexpr int kAltDown = 1 << 3;
inline constexpr int kCommandDown = 1 << 4;
inline constexpr int kShortcutModifiers = kShiftDown | kControlDown | kAltDown | kCommandDown;

inline bool ShortcutAccepted(int key_code, int modifiers, bool has_command, bool suppressed) {
  return key_code >= 1 && key_code <= 255 && modifiers >= 0 && (modifiers & ~kShortcutModifiers) == 0 &&
         (has_command || suppressed);
}

enum class ShortcutTiming { kBeforePage, kAfterPage };

inline ShortcutTiming ShortcutTimingFor(bool not_in_text) {
  return not_in_text ? ShortcutTiming::kAfterPage : ShortcutTiming::kBeforePage;
}

inline constexpr std::size_t kWindowIdLimit = 256;
inline constexpr std::string_view kSettingsWindow = "settings";
inline constexpr std::string_view kImportWindow = "import";
inline constexpr std::string_view kBrowserWindowKind = "browser";
inline constexpr std::string_view kSmallWindowKind = "small";

inline bool UtilityKind(std::string_view kind) {
  return kind == kSettingsWindow || kind == kImportWindow;
}

inline bool ValidWindowId(std::string_view id) {
  if (id.empty() || id.size() > kWindowIdLimit) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' ||
           c == ':' || c == '.';
  });
}

inline bool ValidProfileId(std::string_view name) {
  if (name.empty() || name.size() > 128) return false;
  const char first = name.front();
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z'))) return false;
  return std::all_of(name.begin(), name.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
  });
}

inline std::string_view WindowKindFor(std::string_view kind) {
  if (UtilityKind(kind)) return kind;
  return kind == kSmallWindowKind ? kSmallWindowKind : kBrowserWindowKind;
}

enum class WindowRefusal { kNone, kInvalid, kPrivateUnavailable, kProfile };

struct WindowRequest {
  std::string_view id;
  std::string_view kind;
  std::string_view profile;
  bool incognito = false;
  bool private_seed = false;
};

inline WindowRefusal CheckWindowRequest(const WindowRequest& request) {
  if (!ValidWindowId(request.id)) return WindowRefusal::kInvalid;
  const bool utility = UtilityKind(request.kind);
  if (utility && request.id != request.kind) return WindowRefusal::kInvalid;
  if (!utility && UtilityKind(request.id)) return WindowRefusal::kInvalid;
  if (request.incognito || request.private_seed) return WindowRefusal::kPrivateUnavailable;
  if (!request.profile.empty() && request.profile != "default" && !ValidProfileId(request.profile)) {
    return WindowRefusal::kProfile;
  }
  return WindowRefusal::kNone;
}

inline std::string_view PageProfileFor(std::string_view kind, std::string_view profile) {
  if (UtilityKind(kind) || profile == "default") return std::string_view();
  return profile;
}

enum class DepartureStep { kNone, kCommit, kDiscard };

inline DepartureStep DepartureStepFor(bool held, bool window_closing, bool same_close) {
  if (!held) return DepartureStep::kNone;
  return window_closing && same_close ? DepartureStep::kCommit : DepartureStep::kDiscard;
}

inline bool AcceleratorsLive(bool attached, bool renderer, bool recording) {
  return attached && renderer && !recording;
}

enum class RecordingRoute { kNormal, kToShell };

inline RecordingRoute RecordingRouteFor(bool recording, bool in_this_window, bool command_or_control) {
  return recording && in_this_window && command_or_control ? RecordingRoute::kToShell : RecordingRoute::kNormal;
}

inline std::string_view OfferedProfile(std::string_view profile_name) {
  return profile_name == "default" ? std::string_view() : profile_name;
}

enum class AdoptField { kAbsent, kInvalid, kId };

inline AdoptField ClassifyAdoptField(bool present, bool is_string, std::string_view value) {
  if (!present) return AdoptField::kAbsent;
  if (!is_string || !ParseAdoptId(value)) return AdoptField::kInvalid;
  return AdoptField::kId;
}

enum class CreatePlan { kRefuse, kReclaim, kCreate, kReplace, kAdopt, kAdoptReplacing };

struct CreateRequest {
  AdoptField adopt = AdoptField::kAbsent;
  int adopt_id = 0;
  bool key_bound = false;
  bool same_profile = false;
  int bound_id = 0;
  AdoptRefusal adoption = AdoptRefusal::kNone;
};

inline CreatePlan PlanCreate(const CreateRequest& request) {
  if (request.adopt == AdoptField::kInvalid) return CreatePlan::kRefuse;
  if (request.key_bound && request.same_profile) {
    if (request.adopt == AdoptField::kAbsent || request.adopt_id == request.bound_id) return CreatePlan::kReclaim;
    return CreatePlan::kRefuse;
  }
  if (request.adopt == AdoptField::kId) {
    if (request.adoption != AdoptRefusal::kNone) return CreatePlan::kRefuse;
    return request.key_bound ? CreatePlan::kAdoptReplacing : CreatePlan::kAdopt;
  }
  return request.key_bound ? CreatePlan::kReplace : CreatePlan::kCreate;
}

}

#endif
