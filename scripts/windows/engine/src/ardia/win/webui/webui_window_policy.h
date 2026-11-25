#ifndef ARDIA_WIN_WEBUI_WEBUI_WINDOW_POLICY_H_
#define ARDIA_WIN_WEBUI_WEBUI_WINDOW_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

namespace ardia_win::webui_window {

inline constexpr char kMainWindowId[] = "main";
inline constexpr char kSettingsWindowId[] = "settings";
inline constexpr char kImportWindowId[] = "import";
inline constexpr char kBrowserWindowKind[] = "browser";
inline constexpr char kSmallWindowKind[] = "small";
inline constexpr char kPlacementDocument[] = "window-placement.txt";
inline constexpr size_t kWindowIdLimit = 256;
inline constexpr size_t kOpenWindowLimit = 64;
inline constexpr size_t kTabKeyLimit = 256;
inline constexpr size_t kClaimLimit = 256;
inline constexpr size_t kPresentationLimit = 1024;
inline constexpr size_t kPlacementTextLimit = 256;
inline constexpr size_t kSeedJsonLimit = 64 * 1024;
inline constexpr int kUnclaimedBlankTries = 40;
inline constexpr int kMinimumWindowWidth = 480;
inline constexpr int kMinimumWindowHeight = 360;
inline constexpr int kDefaultWindowWidth = 1280;
inline constexpr int kDefaultWindowHeight = 800;
inline constexpr int kCascadeOffset = 28;
inline constexpr double kCoordinateLimit = 1000000.0;
inline constexpr char kAdoptTabPrefix[] = "tab:";
inline constexpr char kDocumentPrefix[] = "documents.";
inline constexpr char kLiveDocument[] = "live.json";

constexpr bool ValidWindowId(std::string_view id) {
  if (id.empty() || id.size() > kWindowIdLimit) {
    return false;
  }
  for (char c : id) {
    const bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    const bool digit = c >= '0' && c <= '9';
    if (!letter && !digit && c != '-' && c != '_' && c != '.' && c != ':') {
      return false;
    }
  }
  return true;
}

constexpr bool ValidBoundedText(std::string_view text, size_t limit) {
  if (text.empty() || text.size() > limit) {
    return false;
  }
  for (char c : text) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) {
      return false;
    }
  }
  return true;
}

constexpr bool ValidTabKey(std::string_view key) {
  return ValidBoundedText(key, kTabKeyLimit);
}

constexpr bool ValidClaim(std::string_view claim) {
  return ValidBoundedText(claim, kClaimLimit);
}

enum class WindowKind { kBrowser, kSmall, kSettings, kImport };

constexpr std::string_view WindowKindName(WindowKind kind) {
  switch (kind) {
    case WindowKind::kBrowser:
      return kBrowserWindowKind;
    case WindowKind::kSmall:
      return kSmallWindowKind;
    case WindowKind::kSettings:
      return kSettingsWindowId;
    case WindowKind::kImport:
      return kImportWindowId;
  }
  return kBrowserWindowKind;
}

constexpr bool IsUtility(WindowKind kind) {
  return kind == WindowKind::kSettings || kind == WindowKind::kImport;
}

constexpr std::optional<WindowKind> ClassifyOpenWindow(std::string_view id,
                                                      std::string_view kind) {
  if (!ValidWindowId(id)) {
    return std::nullopt;
  }
  const bool utility_id = id == kSettingsWindowId || id == kImportWindowId;
  if (kind == kSettingsWindowId || kind == kImportWindowId) {
    if (id != kind) {
      return std::nullopt;
    }
    return kind == kSettingsWindowId ? WindowKind::kSettings
                                     : WindowKind::kImport;
  }
  if (utility_id) {
    return std::nullopt;
  }
  if (kind.empty() || kind == kBrowserWindowKind) {
    return WindowKind::kBrowser;
  }
  if (kind == kSmallWindowKind) {
    return WindowKind::kSmall;
  }
  return std::nullopt;
}

struct OpenWindowProfile {
  bool incognito = false;
  bool private_profile = false;
  bool has_private_seed = false;
  bool has_small_seed = false;
};

constexpr bool OpenWindowProfileAllowed(WindowKind kind,
                                        const OpenWindowProfile& profile) {
  if (profile.has_private_seed && !profile.incognito) {
    return false;
  }
  if (profile.private_profile != profile.incognito) {
    return false;
  }
  if (IsUtility(kind) && profile.incognito) {
    return false;
  }
  if (profile.has_small_seed &&
      (kind != WindowKind::kSmall || profile.incognito)) {
    return false;
  }
  return true;
}

enum class MemberRoute { kWindowBrowser, kCompanion, kRefuse };

struct MemberRequest {
  bool window_private = false;
  bool window_utility = false;
  bool requested_private = false;
  bool requested_is_window_profile = false;
  bool window_closing = false;
};

constexpr MemberRoute RouteProfile(const MemberRequest& request) {
  if (request.requested_is_window_profile) {
    return MemberRoute::kWindowBrowser;
  }
  if (request.window_private || request.window_utility ||
      request.requested_private || request.window_closing) {
    return MemberRoute::kRefuse;
  }
  return MemberRoute::kCompanion;
}

class SelectionSequence {
 public:
  constexpr bool Admit(uint64_t generation, uint64_t sequence) {
    if (generation != generation_) {
      generation_ = generation;
      sequence_ = 0;
    }
    if (sequence < sequence_) {
      return false;
    }
    sequence_ = sequence;
    return true;
  }

  constexpr bool Current(uint64_t generation, uint64_t sequence) const {
    return generation == generation_ && sequence == sequence_;
  }

 private:
  uint64_t generation_ = 0;
  uint64_t sequence_ = 0;
};

constexpr bool CanReclaim(std::string_view current_claim,
                          std::string_view previous_claim) {
  return current_claim.empty() || current_claim == previous_claim;
}

enum class UnclaimedStep { kWait, kPark, kDrop, kReport };

constexpr UnclaimedStep NextUnclaimedStep(bool in_window,
                                          bool claimed,
                                          bool listening,
                                          bool blank,
                                          int tries) {
  if (!in_window || claimed) {
    return UnclaimedStep::kDrop;
  }
  if (blank && tries < kUnclaimedBlankTries) {
    return UnclaimedStep::kWait;
  }
  if (!listening) {
    return UnclaimedStep::kPark;
  }
  return UnclaimedStep::kReport;
}

constexpr std::optional<int> ParseAdoptId(std::string_view adopt) {
  const std::string_view prefix(kAdoptTabPrefix);
  if (adopt.size() <= prefix.size() || adopt.substr(0, prefix.size()) != prefix ||
      adopt.size() > prefix.size() + 10) {
    return std::nullopt;
  }
  int64_t value = 0;
  for (char c : adopt.substr(prefix.size())) {
    if (c < '0' || c > '9') {
      return std::nullopt;
    }
    value = value * 10 + (c - '0');
    if (value > std::numeric_limits<int>::max()) {
      return std::nullopt;
    }
  }
  if (value <= 0) {
    return std::nullopt;
  }
  return static_cast<int>(value);
}

enum class DocumentVerb { kWatch, kUnwatch, kCommit, kFlush };

constexpr std::optional<DocumentVerb> ParseDocumentVerb(std::string_view name) {
  const std::string_view prefix(kDocumentPrefix);
  if (name.size() <= prefix.size() || name.substr(0, prefix.size()) != prefix) {
    return std::nullopt;
  }
  const std::string_view verb = name.substr(prefix.size());
  if (verb == "watch") {
    return DocumentVerb::kWatch;
  }
  if (verb == "unwatch") {
    return DocumentVerb::kUnwatch;
  }
  if (verb == "commit") {
    return DocumentVerb::kCommit;
  }
  if (verb == "flush") {
    return DocumentVerb::kFlush;
  }
  return std::nullopt;
}

constexpr std::string_view DocumentVerbName(DocumentVerb verb) {
  switch (verb) {
    case DocumentVerb::kWatch:
      return "watch";
    case DocumentVerb::kUnwatch:
      return "unwatch";
    case DocumentVerb::kCommit:
      return "commit";
    case DocumentVerb::kFlush:
      return "flush";
  }
  return "watch";
}

constexpr bool DocumentSubscriptionVerb(DocumentVerb verb) {
  return verb == DocumentVerb::kWatch || verb == DocumentVerb::kUnwatch;
}

class DocumentSubscription {
 public:
  constexpr std::optional<uint64_t> Renew(bool watch) {
    if (sequence_ == std::numeric_limits<uint64_t>::max()) {
      return std::nullopt;
    }
    ++sequence_;
    watched_ = watch;
    return sequence_;
  }

  constexpr void Retire() {
    if (sequence_ != std::numeric_limits<uint64_t>::max()) {
      ++sequence_;
    }
    watched_ = false;
  }

  constexpr bool Delivers(uint64_t sequence) const {
    return watched_ && sequence == sequence_;
  }

  constexpr uint64_t sequence() const { return sequence_; }
  constexpr bool watched() const { return watched_; }

 private:
  uint64_t sequence_ = 0;
  bool watched_ = false;
};

inline bool ValidRect(double x, double y, double width, double height) {
  const auto bounded = [](double value) {
    return std::isfinite(value) && value >= -kCoordinateLimit &&
           value <= kCoordinateLimit;
  };
  return bounded(x) && bounded(y) && bounded(width) && bounded(height) &&
         width >= 0 && height >= 0;
}

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  constexpr int right() const { return x + width; }
  constexpr int bottom() const { return y + height; }
  friend constexpr bool operator==(const Rect&, const Rect&) = default;
};

struct Placement {
  Rect frame;
  bool maximized = false;
  friend constexpr bool operator==(const Placement&, const Placement&) = default;
};

namespace internal {

constexpr bool IsSpace(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

constexpr std::optional<double> ParseDecimal(std::string_view text) {
  if (text.empty() || text.size() > 32) {
    return std::nullopt;
  }
  size_t at = 0;
  bool negative = false;
  if (text[at] == '-' || text[at] == '+') {
    negative = text[at] == '-';
    ++at;
  }
  double whole = 0;
  size_t digits = 0;
  while (at < text.size() && text[at] >= '0' && text[at] <= '9') {
    whole = whole * 10 + (text[at] - '0');
    ++at;
    ++digits;
  }
  if (at < text.size() && text[at] == '.') {
    ++at;
    double scale = 0.1;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') {
      whole += (text[at] - '0') * scale;
      scale /= 10;
      ++at;
      ++digits;
    }
  }
  if (digits == 0 || at != text.size()) {
    return std::nullopt;
  }
  return negative ? -whole : whole;
}

constexpr int RoundToInt(double value) {
  return static_cast<int>(value < 0 ? value - 0.5 : value + 0.5);
}

}

inline std::optional<Placement> ParsePlacement(std::string_view text) {
  if (text.empty() || text.size() > kPlacementTextLimit) {
    return std::nullopt;
  }
  double numbers[5] = {};
  size_t count = 0;
  size_t at = 0;
  while (at < text.size()) {
    while (at < text.size() && internal::IsSpace(text[at])) {
      ++at;
    }
    if (at == text.size()) {
      break;
    }
    size_t end = at;
    while (end < text.size() && !internal::IsSpace(text[end])) {
      ++end;
    }
    if (count == 5) {
      return std::nullopt;
    }
    const std::optional<double> value =
        internal::ParseDecimal(text.substr(at, end - at));
    if (!value) {
      return std::nullopt;
    }
    numbers[count++] = *value;
    at = end;
  }
  if (count != 5 ||
      !ValidRect(numbers[0], numbers[1], numbers[2], numbers[3]) ||
      numbers[2] <= 0 || numbers[3] <= 0 ||
      (numbers[4] != 0 && numbers[4] != 1)) {
    return std::nullopt;
  }
  Placement placement;
  placement.frame = {internal::RoundToInt(numbers[0]),
                     internal::RoundToInt(numbers[1]),
                     internal::RoundToInt(numbers[2]),
                     internal::RoundToInt(numbers[3])};
  if (placement.frame.width <= 0 || placement.frame.height <= 0) {
    return std::nullopt;
  }
  placement.maximized = numbers[4] == 1;
  return placement;
}

inline std::string SerializePlacement(const Placement& placement) {
  return std::to_string(placement.frame.x) + " " +
         std::to_string(placement.frame.y) + " " +
         std::to_string(placement.frame.width) + " " +
         std::to_string(placement.frame.height) + " " +
         (placement.maximized ? "1" : "0") + "\n";
}

constexpr Rect FitToWorkArea(Rect frame, const Rect& work_area) {
  if (work_area.width <= 0 || work_area.height <= 0) {
    return frame;
  }
  frame.width = std::clamp(frame.width, std::min(kMinimumWindowWidth, work_area.width),
                           work_area.width);
  frame.height = std::clamp(frame.height,
                            std::min(kMinimumWindowHeight, work_area.height),
                            work_area.height);
  frame.x = std::clamp(frame.x, work_area.x, work_area.right() - frame.width);
  frame.y = std::clamp(frame.y, work_area.y, work_area.bottom() - frame.height);
  return frame;
}

constexpr Rect CenteredDefault(const Rect& work_area) {
  const int width = std::min(kDefaultWindowWidth, work_area.width);
  const int height = std::min(kDefaultWindowHeight, work_area.height);
  return {work_area.x + (work_area.width - width) / 2,
          work_area.y + (work_area.height - height) / 2, width, height};
}

constexpr Rect CascadeFrom(const Rect& front, const Rect& work_area) {
  Rect next = front;
  next.x += kCascadeOffset;
  next.y += kCascadeOffset;
  if (work_area.width > 0 && work_area.height > 0 &&
      (next.right() > work_area.right() || next.bottom() > work_area.bottom())) {
    next.x = work_area.x;
    next.y = work_area.y;
  }
  return FitToWorkArea(next, work_area);
}

enum class PlacementSource { kRequested, kFront, kSaved, kDefault };

constexpr std::optional<Rect> EffectivePlacementRect(
    const std::optional<Rect>& requested,
    const std::optional<Placement>& front,
    const std::optional<Placement>& saved) {
  if (requested && requested->width > 0 && requested->height > 0) {
    return requested;
  }
  if (front) {
    Rect next = front->frame;
    next.x += kCascadeOffset;
    next.y += kCascadeOffset;
    return next;
  }
  if (saved) {
    return saved->frame;
  }
  return std::nullopt;
}

struct PlacementChoice {
  Rect frame;
  bool maximized = false;
  PlacementSource source = PlacementSource::kDefault;
};

constexpr PlacementChoice ChoosePlacement(
    const std::optional<Rect>& requested,
    const std::optional<Placement>& front,
    const std::optional<Placement>& saved,
    const Rect& work_area,
    std::optional<bool> requested_maximized = std::nullopt) {
  PlacementChoice choice{CenteredDefault(work_area), false,
                         PlacementSource::kDefault};
  if (requested && requested->width > 0 && requested->height > 0) {
    choice = {FitToWorkArea(*requested, work_area), false,
              PlacementSource::kRequested};
  } else if (front) {
    choice = {CascadeFrom(front->frame, work_area), front->maximized,
              PlacementSource::kFront};
  } else if (saved) {
    choice = {FitToWorkArea(saved->frame, work_area), saved->maximized,
              PlacementSource::kSaved};
  }
  if (requested_maximized) {
    choice.maximized = *requested_maximized;
  }
  return choice;
}

inline constexpr size_t kPickerPromptLimit = 200;
inline constexpr size_t kDocumentEngineRequestLimit = 8 * 1024 * 1024;
inline constexpr char kAppProfileName[] = "default";

constexpr size_t Utf8SequenceLength(unsigned char lead) {
  if (lead < 0x80) {
    return 1;
  }
  if (lead >= 0xc2 && lead <= 0xdf) {
    return 2;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return 3;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    return 4;
  }
  return 0;
}

constexpr bool ValidUtf8(std::string_view text) {
  size_t at = 0;
  while (at < text.size()) {
    const unsigned char lead = static_cast<unsigned char>(text[at]);
    const size_t length = Utf8SequenceLength(lead);
    if (length == 0 || at + length > text.size()) {
      return false;
    }
    for (size_t next = 1; next < length; ++next) {
      const unsigned char byte = static_cast<unsigned char>(text[at + next]);
      if ((byte & 0xc0) != 0x80) {
        return false;
      }
    }
    if (length > 1) {
      const unsigned char second = static_cast<unsigned char>(text[at + 1]);
      if ((lead == 0xe0 && second < 0xa0) || (lead == 0xed && second > 0x9f) ||
          (lead == 0xf0 && second < 0x90) || (lead == 0xf4 && second > 0x8f)) {
        return false;
      }
    }
    at += length;
  }
  return true;
}

inline std::string TruncateUtf8(std::string text, size_t limit) {
  if (text.size() <= limit) {
    return text;
  }
  size_t end = limit;
  while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xc0) == 0x80) {
    --end;
  }
  text.resize(end);
  return text;
}

constexpr bool CopyTextFits(std::string_view text, size_t limit) {
  return text.size() <= limit && ValidUtf8(text);
}

constexpr bool PickerPromptUsable(std::string_view prompt) {
  if (prompt.empty() || prompt.size() > kPickerPromptLimit ||
      !ValidUtf8(prompt)) {
    return false;
  }
  for (char c : prompt) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) {
      return false;
    }
  }
  return true;
}

inline constexpr size_t kRelaunchUrlLimit = 64;
inline constexpr size_t kRelaunchUrlBytes = 32 * 1024;

constexpr bool RelaunchUrlSchemeAllowed(std::string_view scheme) {
  return scheme == "http" || scheme == "https" || scheme == "file";
}

constexpr bool RelaunchUrlAccepted(std::string_view scheme,
                                   size_t spec_bytes,
                                   size_t already_taken) {
  return RelaunchUrlSchemeAllowed(scheme) && spec_bytes > 0 &&
         spec_bytes <= kRelaunchUrlBytes && already_taken < kRelaunchUrlLimit;
}

constexpr bool DocumentEngineRequestAllowed(std::string_view profile,
                                            size_t json_bytes) {
  return profile == kAppProfileName && json_bytes <= kDocumentEngineRequestLimit;
}

constexpr std::optional<uint64_t> NextBindingGeneration(uint64_t current) {
  if (current == 0 || current == std::numeric_limits<uint64_t>::max()) {
    return std::nullopt;
  }
  return current + 1;
}

constexpr std::string_view PrivateLinkProfile(std::string_view profile) {
  if (profile.empty() || profile.size() > kWindowIdLimit ||
      profile.find('@') != std::string_view::npos) {
    return {};
  }
  for (char c : profile) {
    if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) {
      return {};
    }
  }
  return profile;
}

inline constexpr int kPrivateHandOverTries = 20;

constexpr std::string_view OriginalProfileOf(std::string_view profile) {
  const size_t at = profile.rfind('@');
  return at == std::string_view::npos ? profile : profile.substr(at + 1);
}

enum class HandOverStep { kHanded, kMove, kRetry, kDrop };

constexpr HandOverStep NextHandOverStep(bool handed,
                                        bool same_session_host,
                                        int tries) {
  if (handed) {
    return HandOverStep::kHanded;
  }
  if (tries < kPrivateHandOverTries) {
    return HandOverStep::kRetry;
  }
  return same_session_host ? HandOverStep::kMove : HandOverStep::kDrop;
}

constexpr bool HidesUntilHandedOver(bool started,
                                    bool opening_own_window,
                                    bool normal_window,
                                    bool off_the_record) {
  return started && !opening_own_window && normal_window && off_the_record;
}

constexpr bool KeepsWindowWithoutTabs(bool hosted, bool companion, bool closing) {
  return (hosted || companion) && !closing;
}

}

#endif
