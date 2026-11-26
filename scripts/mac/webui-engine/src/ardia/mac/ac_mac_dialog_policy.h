#ifndef ARDIA_MAC_AC_MAC_DIALOG_POLICY_H_
#define ARDIA_MAC_AC_MAC_DIALOG_POLICY_H_

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>

namespace ardia_mac::dialog_policy {

inline constexpr std::size_t kMaxPending = 16;
inline constexpr std::size_t kMaxSuspensions = 64;
inline constexpr std::size_t kIdMin = 16;
inline constexpr std::size_t kIdMax = 96;
inline constexpr std::size_t kTitleLimit = 4096;
inline constexpr std::size_t kMessageLimit = 16384;
inline constexpr std::size_t kButtonLimit = 1024;
inline constexpr std::size_t kValueLimit = 16384;
inline constexpr std::size_t kPlaceholderLimit = 4096;
inline constexpr std::size_t kSuppressionLimit = 4096;
inline constexpr std::size_t kGenerationLimit = 20;
inline constexpr std::string_view kResolvedEvent = "shell.dialogResolved";

inline bool ValidDialogId(std::string_view id) {
  if (id.size() < kIdMin || id.size() > kIdMax) return false;
  return std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == ':' || c == '_' ||
           c == '-';
  });
}

inline bool ValidGeneration(std::string_view generation) {
  if (generation.empty() || generation.size() > kGenerationLimit || generation.front() == '0') return false;
  return std::all_of(generation.begin(), generation.end(), [](char c) { return c >= '0' && c <= '9'; });
}

struct Text {
  bool present = false;
  bool is_string = false;
  std::string value;
};

struct Flag {
  bool present = false;
  bool is_bool = false;
  bool value = false;
};

struct Request {
  Text dialog_id;
  Text kind;
  bool has_options = false;
  Text window_id;
  Text title;
  Text message;
  Text confirm_title;
  Text cancel_title;
  Text suppression;
  Text value;
  Text placeholder;
  Flag destructive;
};

struct Spec {
  std::string dialog_id;
  bool prompt = false;
  std::string title;
  std::string message;
  std::string confirm_title = "OK";
  std::string cancel_title = "Cancel";
  bool destructive = false;
  bool has_suppression = false;
  std::string suppression;
  std::string value;
  std::string placeholder;
};

inline bool Take(const Text& field, std::size_t limit, std::string& out) {
  if (!field.present) return true;
  if (!field.is_string || field.value.size() > limit) return false;
  out = field.value;
  return true;
}

inline std::optional<Spec> Parse(const Request& request, std::string_view window) {
  if (!request.dialog_id.is_string || !ValidDialogId(request.dialog_id.value)) return std::nullopt;
  if (!request.kind.is_string || (request.kind.value != "confirm" && request.kind.value != "prompt")) {
    return std::nullopt;
  }
  if (!request.has_options || !request.title.present || !request.title.is_string) return std::nullopt;
  if (request.window_id.present && (!request.window_id.is_string || request.window_id.value != window)) {
    return std::nullopt;
  }
  Spec spec;
  spec.dialog_id = request.dialog_id.value;
  spec.prompt = request.kind.value == "prompt";
  if (!Take(request.title, kTitleLimit, spec.title) || !Take(request.message, kMessageLimit, spec.message) ||
      !Take(request.confirm_title, kButtonLimit, spec.confirm_title)) {
    return std::nullopt;
  }
  if (spec.prompt) {
    if (!Take(request.value, kValueLimit, spec.value) ||
        !Take(request.placeholder, kPlaceholderLimit, spec.placeholder)) {
      return std::nullopt;
    }
    return spec;
  }
  if (request.destructive.present && !request.destructive.is_bool) return std::nullopt;
  spec.destructive = request.destructive.present && request.destructive.value;
  spec.has_suppression = request.suppression.present;
  if (!Take(request.cancel_title, kButtonLimit, spec.cancel_title) ||
      !Take(request.suppression, kSuppressionLimit, spec.suppression)) {
    return std::nullopt;
  }
  return spec;
}

inline std::string Displayable(std::string_view text) {
  std::string shown;
  shown.reserve(text.size());
  for (char c : text) {
    const auto byte = static_cast<unsigned char>(c);
    if (c == '\n' || c == '\t') {
      shown.push_back(c);
    } else if (byte < 0x20 || byte == 0x7f) {
      shown.push_back(' ');
    } else {
      shown.push_back(c);
    }
  }
  return shown;
}

inline std::string ButtonTitle(std::string_view text, std::string_view fallback) {
  std::string shown;
  for (char c : text) {
    const auto byte = static_cast<unsigned char>(c);
    shown.push_back(byte < 0x20 || byte == 0x7f ? ' ' : c);
  }
  const auto first = shown.find_first_not_of(' ');
  return first == std::string::npos ? std::string(fallback) : shown;
}

inline std::string Trimmed(std::string_view text) {
  constexpr std::string_view kSpace = " \t\n\r\f\v";
  const auto first = text.find_first_not_of(kSpace);
  if (first == std::string_view::npos) return std::string();
  const auto last = text.find_last_not_of(kSpace);
  return std::string(text.substr(first, last - first + 1));
}

struct Response {
  bool accepted = false;
  bool suppressed = false;
  std::string text = {};
  bool forced = false;
};

struct Resolution {
  bool prompt = false;
  bool confirmed = false;
  bool suppressed = false;
  std::optional<std::string> text;
};

inline Resolution Resolve(const Spec& spec, const Response& response) {
  Resolution resolution;
  resolution.prompt = spec.prompt;
  const bool accepted = response.accepted && !response.forced;
  if (spec.prompt) {
    if (accepted) {
      std::string text = Trimmed(response.text);
      if (!text.empty() && text.size() <= kValueLimit) resolution.text = std::move(text);
    }
    return resolution;
  }
  resolution.confirmed = accepted;
  resolution.suppressed = !response.forced && spec.has_suppression && response.suppressed;
  return resolution;
}

enum class Refusal { kNone, kNotCurrent, kSuspended, kInvalid, kDuplicate, kFull };

inline std::string_view RefusalMessage(Refusal refusal) {
  switch (refusal) {
    case Refusal::kNone:
      return {};
    case Refusal::kNotCurrent:
      return "Dialog requester is not current";
    case Refusal::kSuspended:
      return "Dialogs are suspended for this window";
    case Refusal::kInvalid:
      return "Invalid dialog request";
    case Refusal::kDuplicate:
      return "Dialog is already pending";
    case Refusal::kFull:
      return "Dialog queue is full";
  }
  return {};
}

class Queue {
 public:
  struct Entry {
    Spec spec;
    std::string generation;
    std::uint64_t sequence = 0;
  };

  Refusal Admit(const Spec& spec, std::string_view generation, std::string_view live) {
    if (!ValidGeneration(generation) || generation != live) return Refusal::kNotCurrent;
    if (suspended()) return Refusal::kSuspended;
    if (!ValidDialogId(spec.dialog_id)) return Refusal::kInvalid;
    if (entries_.contains(spec.dialog_id)) return Refusal::kDuplicate;
    if (entries_.size() >= kMaxPending || sequence_ == std::numeric_limits<std::uint64_t>::max()) {
      return Refusal::kFull;
    }
    entries_.emplace(spec.dialog_id, Entry{spec, std::string(generation), ++sequence_});
    return Refusal::kNone;
  }

  const Entry* Next() const {
    if (active_ || suspended() || entries_.empty()) return nullptr;
    const auto next = std::min_element(entries_.begin(), entries_.end(), [](const auto& a, const auto& b) {
      return a.second.sequence < b.second.sequence;
    });
    return &next->second;
  }

  bool Show(std::uint64_t sequence) {
    const Entry* next = Next();
    if (!next || next->sequence != sequence) return false;
    active_ = sequence;
    return true;
  }

  std::optional<Entry> Complete(std::string_view id, std::uint64_t sequence) {
    const auto found = entries_.find(std::string(id));
    if (found == entries_.end() || found->second.sequence != sequence) return std::nullopt;
    Entry entry = std::move(found->second);
    entries_.erase(found);
    if (active_ == sequence) active_ = 0;
    return entry;
  }

  const Entry* Find(std::string_view id) const {
    const auto found = entries_.find(std::string(id));
    return found == entries_.end() ? nullptr : &found->second;
  }

  bool IsActive(std::uint64_t sequence) const { return sequence != 0 && active_ == sequence; }
  std::uint64_t active() const { return active_; }

  std::uint64_t Suspend() {
    if (suspensions_.size() >= kMaxSuspensions || suspension_ == std::numeric_limits<std::uint64_t>::max()) {
      exhausted_ = true;
      return 0;
    }
    suspensions_.insert(++suspension_);
    return suspension_;
  }

  bool Resume(std::uint64_t token) { return token != 0 && suspensions_.erase(token) == 1; }

  bool suspended() const { return exhausted_ || !suspensions_.empty(); }
  std::size_t size() const { return entries_.size(); }
  bool empty() const { return entries_.empty(); }
  const std::map<std::string, Entry>& entries() const { return entries_; }

 private:
  std::map<std::string, Entry> entries_;
  std::uint64_t sequence_ = 0;
  std::uint64_t active_ = 0;
  std::set<std::uint64_t> suspensions_;
  std::uint64_t suspension_ = 0;
  bool exhausted_ = false;
};

}

#endif
