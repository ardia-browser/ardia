// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_FAVICON_TOUCH_THROTTLE_H_
#define CHROME_BROWSER_ARDIA_AC_FAVICON_TOUCH_THROTTLE_H_

#include <cstddef>
#include <list>
#include <map>

namespace ardia {

template <typename Key, typename Time, typename Duration>
class FaviconTouchThrottle {
 public:
  FaviconTouchThrottle(Duration touch_again_after, size_t max_entries)
      : touch_again_after_(touch_again_after < Duration() ? Duration()
                                                          : touch_again_after),
        max_entries_(max_entries ? max_entries : 1) {}

  FaviconTouchThrottle(const FaviconTouchThrottle&) = delete;
  FaviconTouchThrottle& operator=(const FaviconTouchThrottle&) = delete;

  bool ShouldTouch(const Key& key, Time now) {
    DropExpired(now);
    auto found = entries_.find(key);
    if (found != entries_.end()) {
      by_use_.splice(by_use_.end(), by_use_, found->second.use);
      return false;
    }
    while (entries_.size() >= max_entries_) {
      Erase(entries_.find(by_use_.front()));
    }
    auto use = by_use_.insert(by_use_.end(), key);
    auto touch = by_touch_.emplace(now, key);
    entries_.emplace(key, Entry{use, touch});
    return true;
  }

  size_t size() const { return entries_.size(); }

  bool Holds(const Key& key) const { return entries_.count(key) != 0; }

 private:
  using UseOrder = std::list<Key>;
  using TouchOrder = std::multimap<Time, Key>;

  struct Entry {
    typename UseOrder::iterator use;
    typename TouchOrder::iterator touch;
  };

  using Entries = std::map<Key, Entry>;

  bool Expired(Time touched_at, Time now) const {
    if (now < touched_at) {
      return false;
    }
    const Time epoch{};
    if (!(touched_at < epoch) || now < epoch) {
      return !(now - touched_at < touch_again_after_);
    }
    const Duration since_epoch = now - epoch;
    return !(epoch - (touch_again_after_ - since_epoch) < touched_at);
  }

  void DropExpired(Time now) {
    while (!by_touch_.empty() && Expired(by_touch_.begin()->first, now)) {
      Erase(entries_.find(by_touch_.begin()->second));
    }
  }

  void Erase(typename Entries::iterator entry) {
    by_use_.erase(entry->second.use);
    by_touch_.erase(entry->second.touch);
    entries_.erase(entry);
  }

  const Duration touch_again_after_;
  const size_t max_entries_;
  UseOrder by_use_;
  TouchOrder by_touch_;
  Entries entries_;
};

}

#endif
