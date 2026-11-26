#ifndef ARDIA_MAC_AC_MAC_SHARE_POLICY_H_
#define ARDIA_MAC_AC_MAC_SHARE_POLICY_H_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_mac::share_policy {

inline constexpr std::size_t kMaxUrlBytes = 64 * 1024;
inline constexpr std::size_t kMaxTitleBytes = 4 * 1024;
inline constexpr std::size_t kMaxTextBytes = 1024 * 1024;
inline constexpr std::size_t kMaxServiceBytes = 200;
inline constexpr std::size_t kMaxPathBytes = 4096;
inline constexpr double kMaxCoordinate = 1e6;
inline constexpr double kDefaultAnchorTop = 40;
inline constexpr double kDefaultAnchorSide = 2;

struct Anchor {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;

  double mid_x() const { return x + width / 2; }
};

enum class Edge { kBelow, kLeading, kTrailing };

enum class UrlKind { kRefused, kWeb, kFile };

inline bool Finite(double value) {
  return std::isfinite(value) && std::fabs(value) <= kMaxCoordinate;
}

inline std::optional<Anchor> AnchorFrom(std::size_t count, const double* values) {
  if (count != 4 || !values) return std::nullopt;
  for (std::size_t index = 0; index < count; ++index) {
    if (!Finite(values[index])) return std::nullopt;
  }
  if (values[2] < 0 || values[3] < 0) return std::nullopt;
  return Anchor{values[0], values[1], values[2], values[3]};
}

inline Anchor DefaultAnchor(double view_width) {
  const double width = Finite(view_width) && view_width > 0 ? view_width : 0;
  return Anchor{width / 2 - kDefaultAnchorSide / 2, kDefaultAnchorTop, kDefaultAnchorSide, kDefaultAnchorSide};
}

inline Anchor Scaled(const Anchor& anchor, double zoom) {
  const double scale = std::isfinite(zoom) && zoom > 0.05 && zoom < 20 ? zoom : 1;
  return Anchor{anchor.x * scale, anchor.y * scale, anchor.width * scale, anchor.height * scale};
}

inline Edge EdgeFor(const std::optional<Anchor>& anchor, double view_width) {
  if (!anchor) return Edge::kBelow;
  return anchor->mid_x() < view_width / 2 ? Edge::kTrailing : Edge::kLeading;
}

inline bool NoControls(std::string_view text) {
  return std::none_of(text.begin(), text.end(), [](char c) {
    const auto byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

inline bool StartsWithIgnoringCase(std::string_view text, std::string_view prefix) {
  if (text.size() < prefix.size()) return false;
  for (std::size_t index = 0; index < prefix.size(); ++index) {
    char c = text[index];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != prefix[index]) return false;
  }
  return true;
}

inline UrlKind ClassifyUrl(std::string_view url) {
  if (url.empty() || url.size() > kMaxUrlBytes || !NoControls(url)) return UrlKind::kRefused;
  if (StartsWithIgnoringCase(url, "https://") || StartsWithIgnoringCase(url, "http://")) return UrlKind::kWeb;
  if (StartsWithIgnoringCase(url, "file:///")) return UrlKind::kFile;
  return UrlKind::kRefused;
}

inline bool ValidTitle(std::string_view title) {
  return title.size() <= kMaxTitleBytes;
}

inline bool ShareableText(std::string_view text) {
  return !text.empty() && text.size() <= kMaxTextBytes;
}

inline bool ValidServiceName(std::string_view service) {
  return !service.empty() && service.size() <= kMaxServiceBytes && NoControls(service);
}

inline bool CleanAbsolutePath(std::string_view path) {
  if (path.size() < 2 || path.size() > kMaxPathBytes || path.front() != '/' || !NoControls(path)) return false;
  std::size_t start = 1;
  while (start <= path.size()) {
    const std::size_t end = std::min(path.find('/', start), path.size());
    const std::string_view part = path.substr(start, end - start);
    if (part.empty() && end != path.size()) return false;
    if (part == "." || part == "..") return false;
    start = end + 1;
  }
  return true;
}

enum class PageShare { kText, kLink, kImage, kVideo, kAudio, kPage };

enum class PageMedia { kNone, kImage, kVideo, kAudio, kOther };

struct PageShareInput {
  bool editable = false;
  bool link_is_web = false;
  bool has_selection = false;
  bool selection_is_link_text = false;
  PageMedia media = PageMedia::kNone;
  bool has_image_contents = false;
  bool source_is_web = false;
  bool page_is_web = false;
};

inline constexpr std::size_t kMaxPageShares = 10;

inline std::vector<PageShare> SharesFor(const PageShareInput& input) {
  std::vector<PageShare> shares;
  if (input.editable) return shares;
  if (input.has_selection && !(input.link_is_web && input.selection_is_link_text)) shares.push_back(PageShare::kText);
  if (input.link_is_web) shares.push_back(PageShare::kLink);
  if (input.media == PageMedia::kImage && input.has_image_contents) shares.push_back(PageShare::kImage);
  if (input.media == PageMedia::kVideo && input.source_is_web) shares.push_back(PageShare::kVideo);
  if (input.media == PageMedia::kAudio && input.source_is_web) shares.push_back(PageShare::kAudio);
  if (shares.empty() && input.media == PageMedia::kNone && input.page_is_web) shares.push_back(PageShare::kPage);
  return shares;
}

inline std::string_view KindName(PageShare share) {
  switch (share) {
    case PageShare::kText:
      return "text";
    case PageShare::kLink:
      return "link";
    case PageShare::kImage:
      return "image";
    case PageShare::kVideo:
      return "video";
    case PageShare::kAudio:
      return "audio";
    case PageShare::kPage:
      return "page";
  }
  return "page";
}

inline std::string_view ShareTitle(PageShare share, bool only) {
  if (only) return "Share…";
  switch (share) {
    case PageShare::kText:
      return "Share Text…";
    case PageShare::kLink:
      return "Share Link…";
    case PageShare::kImage:
      return "Share Image…";
    case PageShare::kVideo:
      return "Share Video…";
    case PageShare::kAudio:
      return "Share Audio…";
    case PageShare::kPage:
      return "Share Page…";
  }
  return "Share…";
}

inline std::string_view ImageExtension(std::string_view mime_type) {
  if (mime_type == "image/png") return "png";
  if (mime_type == "image/jpeg" || mime_type == "image/jpg") return "jpg";
  if (mime_type == "image/gif") return "gif";
  if (mime_type == "image/webp") return "webp";
  if (mime_type == "image/bmp") return "bmp";
  return "png";
}

inline bool InsideDirectory(std::string_view path, std::string_view directory) {
  if (!CleanAbsolutePath(path) || !CleanAbsolutePath(directory)) return false;
  while (directory.size() > 1 && directory.back() == '/') directory.remove_suffix(1);
  return path.size() > directory.size() + 1 && path.starts_with(directory) && path[directory.size()] == '/' &&
         path.find('/', directory.size() + 1) == std::string_view::npos;
}

inline constexpr std::size_t kMaxIssuedFiles = 64;
inline constexpr std::size_t kMaxInstanceNonce = 64;

template <typename Key, typename Value>
class KeyedOwner {
 public:
  Value* Attach(Key key, std::unique_ptr<Value> value) {
    Value* raw = value.get();
    entries_[key] = std::move(value);
    return raw;
  }
  Value* Find(Key key) const {
    const auto found = entries_.find(key);
    return found == entries_.end() ? nullptr : found->second.get();
  }
  bool Release(Key key) { return entries_.erase(key) > 0; }
  std::size_t size() const { return entries_.size(); }

 private:
  std::map<Key, std::unique_ptr<Value>> entries_;
};

struct Issuance {
  bool issued = false;
  std::optional<std::string> evicted;
};

inline constexpr int kShareCommandFirst = 54100;
inline constexpr int kShareCommandLast = kShareCommandFirst + static_cast<int>(kMaxPageShares) - 1;

enum class Slot { kReserved, kIssued, kTaken, kRevoked };

template <typename Owner>
class IssuedFiles {
 public:
  Issuance Reserve(std::string path, Owner owner) {
    if (entries_.contains(path)) return Issuance{};
    if (entries_.size() >= kMaxIssuedFiles) {
      const auto waiting = std::find_if(order_.begin(), order_.end(),
                                        [this](const std::string& held) { return entries_.at(held).slot == Slot::kIssued; });
      if (waiting == order_.end()) return Issuance{};
      entries_.at(*waiting).slot = Slot::kRevoked;
      return Issuance{false, *waiting};
    }
    order_.push_back(path);
    entries_.emplace(std::move(path), Entry{std::move(owner), Slot::kReserved});
    return Issuance{true, std::nullopt};
  }

  bool Publish(std::string_view path) {
    const auto found = entries_.find(std::string(path));
    if (found == entries_.end() || found->second.slot != Slot::kReserved) return false;
    found->second.slot = Slot::kIssued;
    return true;
  }

  template <typename Accept>
  bool Take(std::string_view path, Accept accept) {
    const auto found = entries_.find(std::string(path));
    if (found == entries_.end() || found->second.slot != Slot::kIssued || !accept(found->second.owner)) {
      return false;
    }
    found->second.slot = Slot::kTaken;
    return true;
  }

  bool Holds(std::string_view path) const { return entries_.contains(std::string(path)); }

  std::optional<Slot> SlotOf(std::string_view path) const {
    const auto found = entries_.find(std::string(path));
    return found == entries_.end() ? std::nullopt : std::optional(found->second.slot);
  }

  bool Shareable(std::string_view path) const { return SlotOf(path) == Slot::kIssued; }

  bool Revoke(std::string_view path) {
    const auto found = entries_.find(std::string(path));
    if (found == entries_.end()) return false;
    found->second.slot = Slot::kRevoked;
    return true;
  }

  struct Revoked {
    std::vector<std::string> writing;
    std::vector<std::string> written;
  };

  template <typename Match>
  Revoked RevokeUnheld(Match match) {
    Revoked revoked;
    for (auto& [path, entry] : entries_) {
      if ((entry.slot == Slot::kIssued || entry.slot == Slot::kReserved) && match(entry.owner)) {
        (entry.slot == Slot::kReserved ? revoked.writing : revoked.written).push_back(path);
        entry.slot = Slot::kRevoked;
      }
    }
    return revoked;
  }

  bool Release(std::string_view path) {
    const std::string key(path);
    std::erase(order_, key);
    return entries_.erase(key) > 0;
  }

  std::size_t size() const { return entries_.size(); }

 private:
  struct Entry {
    Owner owner;
    Slot slot = Slot::kReserved;
  };

  std::map<std::string, Entry> entries_;
  std::deque<std::string> order_;
};

inline constexpr int kMaxUnlinkAttempts = 5;
inline constexpr int kFirstUnlinkRetryMs = 500;

enum class UnlinkStep { kRelease, kRetry, kGiveUp };

inline UnlinkStep NextUnlinkStep(int attempt, bool gone) {
  if (gone) return UnlinkStep::kRelease;
  return attempt + 1 < kMaxUnlinkAttempts ? UnlinkStep::kRetry : UnlinkStep::kGiveUp;
}

inline int UnlinkRetryDelayMs(int attempt) {
  const int bounded = std::clamp(attempt, 0, kMaxUnlinkAttempts);
  return kFirstUnlinkRetryMs << bounded;
}

inline bool KeepsServiceAfterRetire(bool service_chosen) {
  return service_chosen;
}

inline bool SameChoice(bool service_known, bool same_service) {
  return !service_known || same_service;
}

enum class InstanceLock { kMissing, kHeld, kFree };

inline bool SweepsInstance(bool recognized, bool own, InstanceLock lock, bool process_alive) {
  if (!recognized || own) return false;
  if (lock == InstanceLock::kFree) return true;
  return lock == InstanceLock::kMissing && !process_alive;
}

inline bool NonceCharacter(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || c == '-';
}

inline std::optional<std::string> InstanceDirectoryName(long pid, std::string_view nonce) {
  if (pid <= 0 || nonce.empty() || nonce.size() > kMaxInstanceNonce ||
      !std::all_of(nonce.begin(), nonce.end(), NonceCharacter)) {
    return std::nullopt;
  }
  return std::to_string(pid) + "-" + std::string(nonce);
}

inline std::optional<long> InstancePid(std::string_view name) {
  const std::size_t dash = name.find('-');
  if (dash == 0 || dash == std::string_view::npos || dash > 10 || dash + 1 >= name.size()) return std::nullopt;
  long pid = 0;
  for (char c : name.substr(0, dash)) {
    if (c < '0' || c > '9') return std::nullopt;
    pid = pid * 10 + (c - '0');
  }
  const std::string_view nonce = name.substr(dash + 1);
  if (pid <= 0 || pid > 0x7fffffffL || nonce.size() > kMaxInstanceNonce ||
      !std::all_of(nonce.begin(), nonce.end(), NonceCharacter)) {
    return std::nullopt;
  }
  return pid;
}

inline std::optional<long> StagingPid(std::string_view name) {
  constexpr std::string_view suffix = ".staging";
  if (name.size() <= 1 + suffix.size() || name.front() != '.' || !name.ends_with(suffix)) return std::nullopt;
  return InstancePid(name.substr(1, name.size() - 1 - suffix.size()));
}

inline bool SweepsStaging(bool own, bool lock_held, bool process_alive) {
  return !own && !lock_held && !process_alive;
}

}

#endif
