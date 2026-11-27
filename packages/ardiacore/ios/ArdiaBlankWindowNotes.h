#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <utility>

namespace ardia_blank_window_notes {

constexpr double kPairWithinSeconds = 0.25;
constexpr double kUnboundSeconds = 1;
constexpr std::size_t kTabsKept = 8;
constexpr std::size_t kNotesKept = 8;

class Pairing {
 public:
  void OpenedBlank(std::uint64_t tab, double now) {
    Expire(now);
    tabs_.push_back({tab, now, std::nullopt});
    while (tabs_.size() > kTabsKept) tabs_.pop_front();
    Bind();
  }

  void Noted(std::string url, double now) {
    Expire(now);
    notes_.push_back({std::move(url), now});
    while (notes_.size() > kNotesKept) notes_.pop_front();
    Bind();
  }

  std::optional<std::string> Take(std::uint64_t tab, double now) {
    Expire(now);
    const auto found = std::find_if(tabs_.begin(), tabs_.end(), [tab](const Tab& t) { return t.id == tab; });
    if (found == tabs_.end() || !found->url) return std::nullopt;
    std::optional<std::string> url = std::move(found->url);
    tabs_.erase(found);
    return url;
  }

  void Forget(std::uint64_t tab) {
    std::erase_if(tabs_, [tab](const Tab& t) { return t.id == tab; });
  }

  std::size_t pending_tabs() const { return tabs_.size(); }
  std::size_t pending_notes() const { return notes_.size(); }

 private:
  struct Tab {
    std::uint64_t id;
    double at;
    std::optional<std::string> url;
  };
  struct Note {
    std::string url;
    double at;
  };

  void Expire(double now) {
    std::erase_if(tabs_, [now](const Tab& t) { return !t.url && now - t.at > kUnboundSeconds; });
    std::erase_if(notes_, [now](const Note& n) { return now - n.at > kUnboundSeconds; });
  }

  void Bind() {
    for (Tab& tab : tabs_) {
      if (tab.url) continue;
      const auto note = std::find_if(notes_.begin(), notes_.end(), [&tab](const Note& n) { return std::fabs(n.at - tab.at) <= kPairWithinSeconds; });
      if (note == notes_.end()) continue;
      tab.url = std::move(note->url);
      notes_.erase(note);
    }
  }

  std::deque<Tab> tabs_;
  std::deque<Note> notes_;
};

}
