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
constexpr double kFreshNoteSeconds = 0.05;
constexpr double kOlderTabSeconds = 0.05;
constexpr double kUnboundSeconds = 1;
constexpr std::size_t kTabsKept = 8;
constexpr std::size_t kNotesKept = 8;

class Pairing {
 public:
  void OpenedBlank(std::uint64_t tab, double now) {
    Expire(now);
    tabs_.push_back({tab, now, std::nullopt});
    while (tabs_.size() > kTabsKept) tabs_.pop_front();
  }

  void Noted(std::string url, double now) {
    Expire(now);
    notes_.push_back({std::move(url), now});
    while (notes_.size() > kNotesKept) notes_.pop_front();
  }

  std::optional<std::string> Take(std::uint64_t tab, double now) {
    Bind(now);
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

  bool NoteNear(double at) const {
    return std::any_of(notes_.begin(), notes_.end(), [at](const Note& n) { return std::fabs(n.at - at) <= kPairWithinSeconds; });
  }

  bool OpenTabNear(double at) const {
    return std::any_of(tabs_.begin(), tabs_.end(), [at](const Tab& t) { return !t.url && std::fabs(t.at - at) <= kPairWithinSeconds; });
  }

  void Expire(double now) {
    std::erase_if(tabs_, [&](const Tab& t) { return !t.url && now - t.at > kUnboundSeconds && !NoteNear(t.at); });
    std::erase_if(notes_, [&](const Note& n) { return now - n.at > kUnboundSeconds && !OpenTabNear(n.at); });
  }

  void Bind(double now) {
    for (;;) {
      Tab* closest_tab = nullptr;
      auto closest_note = notes_.end();
      double closest = kPairWithinSeconds;
      for (Tab& tab : tabs_) {
        if (tab.url) continue;
        for (auto note = notes_.begin(); note != notes_.end(); ++note) {
          const double gap = std::fabs(note->at - tab.at);
          if (gap > closest || (closest_tab && gap == closest)) continue;
          if (now - note->at < kFreshNoteSeconds && note->at - tab.at > kOlderTabSeconds) continue;
          closest = gap;
          closest_tab = &tab;
          closest_note = note;
        }
      }
      if (!closest_tab) return;
      closest_tab->url = std::move(closest_note->url);
      notes_.erase(closest_note);
    }
  }

  std::deque<Tab> tabs_;
  std::deque<Note> notes_;
};

}
