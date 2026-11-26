#ifndef ARDIA_MAC_AC_MAC_PAGE_POLICY_H_
#define ARDIA_MAC_AC_MAC_PAGE_POLICY_H_

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace ardia_mac::page_policy {

inline constexpr std::string_view kPageCommands[] = {
    "find",           "stopFinding",     "print",
    "runPageCommand", "showDevTools",    "zoomStep",
    "goToOffset",     "evaluate",        "edit",
    "getSecurityInfo", "discard",        "sleepIfHidden",
    "setFrozen",      "downloadFavicon", "downloadImage",
    "openBlockedPopup", "resolveUnresponsive",
};

constexpr bool Handles(std::string_view command) {
  for (std::string_view known : kPageCommands) {
    if (known == command) {
      return true;
    }
  }
  return false;
}

inline constexpr std::string_view kZoomRoutes[] = {"sites.zoomLevels",
                                                   "sites.setZoom"};

constexpr bool IsZoomRoute(std::string_view name) {
  return name == kZoomRoutes[0] || name == kZoomRoutes[1];
}

enum class PageAction { kSavePage, kSystemPrint, kViewSource, kUnsupported };

constexpr PageAction PageActionFor(std::string_view name) {
  if (name == "savePage") {
    return PageAction::kSavePage;
  }
  if (name == "systemPrint") {
    return PageAction::kSystemPrint;
  }
  if (name == "viewSource") {
    return PageAction::kViewSource;
  }
  return PageAction::kUnsupported;
}

enum class DevToolsPanel { kShow, kToggle, kInspect, kConsole };

constexpr std::optional<DevToolsPanel> DevToolsPanelFor(
    std::optional<std::string_view> panel) {
  if (!panel) {
    return DevToolsPanel::kShow;
  }
  if (*panel == "toggle") {
    return DevToolsPanel::kToggle;
  }
  if (*panel == "inspect") {
    return DevToolsPanel::kInspect;
  }
  if (*panel == "console") {
    return DevToolsPanel::kConsole;
  }
  return std::nullopt;
}

inline constexpr size_t kFindTextMax = 64 * 1024;

constexpr bool FindTextFits(size_t bytes) {
  return bytes <= kFindTextMax;
}

inline std::optional<int> WholeNumber(double value) {
  if (!std::isfinite(value) || std::trunc(value) != value ||
      value < static_cast<double>(std::numeric_limits<int>::min()) ||
      value > static_cast<double>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  return static_cast<int>(value);
}

inline std::optional<int> HistoryTarget(int current, int count, int offset) {
  const int64_t target = static_cast<int64_t>(current) + static_cast<int64_t>(offset);
  if (offset == 0 || current < 0 || target < 0 || target >= static_cast<int64_t>(count)) {
    return std::nullopt;
  }
  return static_cast<int>(target);
}

inline std::optional<int> ZoomStep(double value) {
  const std::optional<int> step = WholeNumber(value);
  if (!step || *step < -1 || *step > 1) {
    return std::nullopt;
  }
  return step;
}

inline constexpr int kSleepUnavailable = -1;
inline constexpr double kSleepLongestHiddenSeconds = 7 * 24 * 60 * 60;

inline std::optional<double> SleepSeconds(double seconds) {
  if (!std::isfinite(seconds) || seconds < 0 ||
      seconds > kSleepLongestHiddenSeconds) {
    return std::nullopt;
  }
  return seconds;
}

inline constexpr int kImagePixelsMax = 512;

constexpr std::optional<int> ImagePixels(int pixels) {
  if (pixels < 1 || pixels > kImagePixelsMax) {
    return std::nullopt;
  }
  return pixels;
}

constexpr bool ImageScheme(std::string_view scheme) {
  return scheme == "http" || scheme == "https" || scheme == "data";
}

constexpr std::optional<int32_t> PopupId(std::string_view text) {
  if (text.empty() || text.size() > 10) {
    return std::nullopt;
  }
  int64_t value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') {
      return std::nullopt;
    }
    value = value * 10 + (c - '0');
  }
  if (value > std::numeric_limits<int32_t>::max()) {
    return std::nullopt;
  }
  return static_cast<int32_t>(value);
}

struct Protection {
  std::optional<bool> visible;
  std::optional<bool> audible;
  std::optional<bool> playing;
  std::optional<bool> capturing;
  std::optional<bool> picture_in_picture;
  std::optional<bool> pending_prompt;
  std::optional<bool> dirty_input;
};

inline std::optional<std::string> ProtectionReason(const Protection& protection) {
  const std::pair<const std::optional<bool>*, std::string_view> checks[] = {
      {&protection.visible, "visible"},
      {&protection.audible, "playing audio"},
      {&protection.playing, "playing media"},
      {&protection.capturing, "capturing"},
      {&protection.picture_in_picture, "picture in picture"},
      {&protection.pending_prompt, "pending prompt"},
      {&protection.dirty_input, "unsaved input"},
  };
  for (const auto& [value, reason] : checks) {
    if (!value->has_value()) {
      return "unknown " + std::string(reason);
    }
    if (**value) {
      return std::string(reason);
    }
  }
  return std::nullopt;
}

enum class DiscardDecision { kDiscard, kAlready, kRefused, kUnsupported };

inline DiscardDecision DecideDiscard(bool live,
                                     bool discarded,
                                     bool unload,
                                     const Protection& protection) {
  if (unload) {
    return DiscardDecision::kUnsupported;
  }
  if (!live) {
    return DiscardDecision::kRefused;
  }
  if (discarded) {
    return DiscardDecision::kAlready;
  }
  if (ProtectionReason(protection)) {
    return DiscardDecision::kRefused;
  }
  return DiscardDecision::kDiscard;
}

constexpr std::string_view DiscardOutcome(DiscardDecision decision,
                                          bool discarded_now) {
  switch (decision) {
    case DiscardDecision::kDiscard:
      return discarded_now ? "discarded" : "refused";
    case DiscardDecision::kAlready:
      return "already";
    case DiscardDecision::kUnsupported:
      return "unsupported";
    case DiscardDecision::kRefused:
      return "refused";
  }
  return "refused";
}

constexpr bool DiscardSucceeded(bool accepted,
                                bool binding_alive,
                                bool bound_contents_discarded) {
  return accepted && binding_alive && bound_contents_discarded;
}

constexpr bool SessionPlaying(bool active, bool playing) {
  return active && playing;
}

inline bool MayFreeze(const Protection& protection) {
  return !ProtectionReason(protection);
}

inline std::optional<bool> UnsavedInput(std::optional<bool> before_unload,
                                        std::optional<bool> form_interaction,
                                        std::optional<bool> user_edits) {
  if (before_unload.value_or(false) || form_interaction.value_or(false) ||
      user_edits.value_or(false)) {
    return true;
  }
  if (!before_unload || !form_interaction || !user_edits) {
    return std::nullopt;
  }
  return false;
}

enum class PromptHandling { kChrome, kDismissWithoutUi };

constexpr PromptHandling PromptHandlingFor(bool background, bool bound) {
  return background && bound ? PromptHandling::kDismissWithoutUi
                             : PromptHandling::kChrome;
}

enum class StripExit { kKeep, kDestroyed, kDrop };

constexpr StripExit StripExitFor(bool deleted, bool still_in_member_strip) {
  if (deleted) {
    return StripExit::kDestroyed;
  }
  return still_in_member_strip ? StripExit::kKeep : StripExit::kDrop;
}

constexpr bool RebindAllowed(int old_id, int new_id, bool new_id_bound) {
  return old_id > 0 && new_id > 0 && (new_id == old_id || !new_id_bound);
}

constexpr std::optional<uint64_t> NextBindingGeneration(uint64_t generation) {
  if (generation == 0 || generation == std::numeric_limits<uint64_t>::max()) {
    return std::nullopt;
  }
  return generation + 1;
}

constexpr bool ClearsBlockedPopups(bool primary_main_frame,
                                   bool committed,
                                   bool same_document) {
  return primary_main_frame && committed && !same_document;
}

enum class Termination {
  kNormal,
  kAbnormal,
  kKilled,
  kCrashed,
  kStillRunning,
  kOom,
  kLaunchFailed,
  kOther,
};

constexpr bool RendererGone(Termination status) {
  return status != Termination::kNormal && status != Termination::kStillRunning;
}

constexpr std::string_view CrashReason(Termination status) {
  switch (status) {
    case Termination::kAbnormal:
      return "abnormal";
    case Termination::kKilled:
      return "killed";
    case Termination::kCrashed:
      return "crashed";
    case Termination::kOom:
      return "oom";
    case Termination::kLaunchFailed:
      return "launchFailed";
    default:
      return "unknown";
  }
}

inline constexpr int kNetAborted = -3;

constexpr bool NavigationLoadError(int net_error) {
  return net_error != 0 && net_error != kNetAborted;
}

inline std::string ThemeColorText(uint8_t red, uint8_t green, uint8_t blue) {
  char text[8];
  std::snprintf(text, sizeof(text), "#%02x%02x%02x", red, green, blue);
  return std::string(text, 7);
}

inline constexpr size_t kFaviconCandidatesMax = 32;
inline constexpr size_t kBlockedPopupsMax = 100;
inline constexpr size_t kSnapshotEventsMax = 128;
inline constexpr size_t kHungWidgetsMax = 64;

constexpr bool ZoomHostShape(std::string_view host) {
  if (host.empty() || host.size() > 253 ||
      host.find_first_of("/\\?#@ ") != std::string_view::npos) {
    return false;
  }
  for (char c : host) {
    const unsigned char byte = static_cast<unsigned char>(c);
    if (byte < 0x20 || byte == 0x7f) {
      return false;
    }
  }
  return host.find(':') == std::string_view::npos ||
         (host.front() == '[' && host.back() == ']');
}

inline constexpr double kZoomFactorMin = 0.25;
inline constexpr double kZoomFactorMax = 5.0;

inline bool ZoomFactorAllowed(double factor) {
  return std::isfinite(factor) && factor >= kZoomFactorMin &&
         factor <= kZoomFactorMax;
}

inline std::optional<double> ReportedZoomFactor(double factor) {
  const double rounded = std::round(factor * 100) / 100;
  if (!std::isfinite(rounded) || rounded <= 0) {
    return std::nullopt;
  }
  return rounded;
}

inline constexpr size_t kEvaluationCodeMax = 64 * 1024;
inline constexpr size_t kEvaluationResultMax = 4 * 1024 * 1024;
inline constexpr size_t kReplaceTextMax = 4096;
inline constexpr double kPickerCoordinateMax = 1e6;
inline constexpr size_t kPickerSelectorsMax = 512;
inline constexpr size_t kPickerSelectorMax = 3072;

enum class Arguments { kNone, kReplace, kLook, kPoint, kSelectors };

struct Operation {
  std::string_view name;
  size_t length;
  std::string_view sha256;
  Arguments args;
  std::string_view suffix;
};

struct OperationMatch {
  const Operation* operation = nullptr;
  std::string_view arguments;
};

template <typename Digest>
std::optional<OperationMatch> MatchOperation(std::string_view code,
                                             const Digest& digest,
                                             std::span<const Operation> operations) {
  if (code.empty() || code.size() > kEvaluationCodeMax) {
    return std::nullopt;
  }
  for (const Operation& operation : operations) {
    if (operation.args == Arguments::kNone) {
      if (code.size() == operation.length && digest(code) == operation.sha256) {
        return OperationMatch{&operation, {}};
      }
      continue;
    }
    const std::string_view suffix = operation.suffix;
    if (suffix.empty() || code.size() <= operation.length + suffix.size() ||
        !code.ends_with(suffix)) {
      continue;
    }
    if (digest(code.substr(0, operation.length)) != operation.sha256) {
      continue;
    }
    return OperationMatch{
        &operation, code.substr(operation.length,
                                code.size() - operation.length - suffix.size())};
  }
  return std::nullopt;
}

inline std::string JavaScriptString(std::string_view text) {
  std::string out = "\"";
  for (size_t i = 0; i < text.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(text[i]);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += static_cast<char>(c);
    } else if (c < 0x20 || c == '<' || c == '>' || c == 0x7f) {
      char escaped[8];
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(c));
      out += escaped;
    } else if (c == 0xe2 && i + 2 < text.size() &&
               static_cast<unsigned char>(text[i + 1]) == 0x80 &&
               (static_cast<unsigned char>(text[i + 2]) == 0xa8 ||
                static_cast<unsigned char>(text[i + 2]) == 0xa9)) {
      out += static_cast<unsigned char>(text[i + 2]) == 0xa8 ? "\\u2028"
                                                             : "\\u2029";
      i += 2;
    } else {
      out += static_cast<char>(c);
    }
  }
  return out + "\"";
}

constexpr bool BoundedText(std::string_view text) {
  return text.size() <= kReplaceTextMax &&
         text.find('\0') == std::string_view::npos;
}

inline std::optional<std::string> ReplaceArguments(std::string_view find,
                                                   std::string_view replace,
                                                   bool all) {
  if (!BoundedText(find) || !BoundedText(replace)) {
    return std::nullopt;
  }
  return JavaScriptString(find) + ", " + JavaScriptString(replace) + ", " +
         (all ? "true" : "false");
}

inline std::optional<std::string> LookArgument(
    bool dark,
    int size,
    std::string_view font,
    int sizes,
    std::span<const std::string_view> fonts) {
  if (size < 0 || size >= sizes) {
    return std::nullopt;
  }
  for (std::string_view known : fonts) {
    if (font == known) {
      return std::string("{\"dark\":") + (dark ? "true" : "false") +
             ",\"size\":" + std::to_string(size) + ",\"font\":\"" +
             std::string(known) + "\"}";
    }
  }
  return std::nullopt;
}

inline std::optional<std::string> PickerCoordinate(double value) {
  if (!std::isfinite(value) || std::fabs(value) > kPickerCoordinateMax) {
    return std::nullopt;
  }
  char text[40];
  std::snprintf(text, sizeof(text), "%.17g", value);
  return std::string(text);
}

inline std::optional<std::string> PickerPoint(std::optional<double> x,
                                              std::optional<double> y) {
  if (!x && !y) {
    return std::string("null");
  }
  const std::optional<std::string> left = x ? PickerCoordinate(*x) : std::nullopt;
  const std::optional<std::string> top = y ? PickerCoordinate(*y) : std::nullopt;
  if (!left || !top) {
    return std::nullopt;
  }
  return "[" + *left + "," + *top + "]";
}

inline std::optional<std::string> PickerSelectors(
    std::span<const std::string_view> selectors) {
  if (selectors.size() > kPickerSelectorsMax) {
    return std::nullopt;
  }
  std::string out = "[";
  for (size_t i = 0; i < selectors.size(); ++i) {
    const std::string_view selector = selectors[i];
    if (selector.empty() || selector.size() > kPickerSelectorMax ||
        selector.find('\0') != std::string_view::npos) {
      return std::nullopt;
    }
    if (i) {
      out += ",";
    }
    out += JavaScriptString(selector);
  }
  return out + "]";
}

inline std::string WrapEvaluation(std::string_view body) {
  return "(() => {\n"
         "let ardiaResult = null;\n"
         "const post = (kind, value) => { if (kind === \"result\" && "
         "ardiaResult === null && typeof value === \"string\") ardiaResult = "
         "value; };\n"
         "try {\n" +
         std::string(body) +
         "\n;\n} catch (ardiaError) {}\n"
         "return ardiaResult;\n"
         "})()";
}

inline constexpr int kEvaluationPollMilliseconds = 20;
inline constexpr int kEvaluationDeadlineMilliseconds = 5000;
inline constexpr int kEvaluationSlotTtlMilliseconds = 6000;
inline constexpr size_t kEvaluationSlotsMax = 64;

constexpr bool AwaitsResult(const Operation& operation) {
  return operation.args != Arguments::kNone &&
         operation.suffix.find(".then(") != std::string_view::npos &&
         operation.suffix.find("post(\"result\"") != std::string_view::npos;
}

inline std::string EvaluationSlots() {
  return "(globalThis[Symbol.for(\"ardia.evaluations\")] || "
         "(globalThis[Symbol.for(\"ardia.evaluations\")] = new Map()))";
}

inline std::string WrapAwaitedEvaluation(std::string_view body, uint64_t token) {
  const std::string key = std::to_string(token);
  return "(() => {\n"
         "let ardiaResult = null;\n"
         "const ardiaSlots = " +
         EvaluationSlots() +
         ";\n"
         "const ardiaSlot = { pending: true, value: null };\n"
         "ardiaSlots.set(" +
         key +
         ", ardiaSlot);\n"
         "while (ardiaSlots.size > " +
         std::to_string(kEvaluationSlotsMax) +
         ") ardiaSlots.delete(ardiaSlots.keys().next().value);\n"
         "setTimeout(() => { if (ardiaSlots.get(" +
         key + ") === ardiaSlot) ardiaSlots.delete(" + key + "); }, " +
         std::to_string(kEvaluationSlotTtlMilliseconds) +
         ");\n"
         "const post = (kind, value) => { if (kind !== \"result\" || typeof value "
         "!== \"string\" || !ardiaSlot.pending || ardiaSlots.get(" +
         key +
         ") !== ardiaSlot) return; ardiaSlot.pending = false; ardiaSlot.value = "
         "value; if (ardiaResult === null) ardiaResult = value; };\n"
         "try {\n" +
         std::string(body) +
         "\n;\n} catch (ardiaError) {}\n"
         "if (ardiaResult !== null && ardiaSlots.get(" +
         key + ") === ardiaSlot) ardiaSlots.delete(" + key +
         ");\n"
         "return ardiaResult;\n"
         "})()";
}

inline std::string TakeEvaluation(uint64_t token) {
  const std::string key = std::to_string(token);
  return "(() => {\n"
         "const ardiaSlots = " +
         EvaluationSlots() +
         ";\n"
         "const ardiaSlot = ardiaSlots.get(" +
         key +
         ");\n"
         "if (!ardiaSlot || ardiaSlot.pending) return null;\n"
         "ardiaSlots.delete(" +
         key +
         ");\n"
         "return ardiaSlot.value;\n"
         "})()";
}

inline std::string ForgetEvaluation(uint64_t token) {
  return "(() => { " + EvaluationSlots() + ".delete(" + std::to_string(token) +
         "); return null; })()";
}

enum class EvaluationStep { kReply, kReplyNull, kPoll };

constexpr EvaluationStep NextEvaluationStep(bool settled,
                                            bool current_document,
                                            bool has_result,
                                            bool result_fits,
                                            bool awaited) {
  if (settled || !current_document) {
    return EvaluationStep::kReplyNull;
  }
  if (has_result) {
    return result_fits ? EvaluationStep::kReply : EvaluationStep::kReplyNull;
  }
  return awaited ? EvaluationStep::kPoll : EvaluationStep::kReplyNull;
}

constexpr bool EvaluationResultFits(size_t bytes) {
  return bytes <= kEvaluationResultMax;
}

constexpr bool ScriptableScheme(std::string_view scheme) {
  return scheme == "http" || scheme == "https" || scheme == "file";
}

}

#endif
