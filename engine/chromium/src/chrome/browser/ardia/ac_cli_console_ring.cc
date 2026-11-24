// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_console_ring.h"

#include <algorithm>
#include <deque>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "third_party/blink/public/mojom/devtools/console_message.mojom-shared.h"

namespace ardia {
namespace {

constexpr size_t kMaxText = 2048;
constexpr size_t kMaxSource = 512;
constexpr std::string_view kUncaught = "Uncaught ";

struct ConsoleRingCounts {
  uint64_t captured = 0;
  uint64_t evicted = 0;
  uint64_t reads = 0;
  uint64_t rings = 0;
};

ConsoleRingCounts& Counts() {
  static ConsoleRingCounts counts;
  return counts;
}

int Clamped(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

std::string Truncated(std::u16string_view text, size_t bytes) {
  std::u16string_view head = text.substr(0, bytes);
  if (head.size() < text.size() && !head.empty() && head.back() >= 0xD800 &&
      head.back() <= 0xDBFF) {
    head.remove_suffix(1);
  }
  std::string out;
  base::TruncateUTF8ToByteSize(base::UTF16ToUTF8(head), bytes, &out);
  return out;
}

uint64_t& LastGeneration() {
  static uint64_t generation = 0;
  return generation;
}

bool FrameInspectable(content::RenderFrameHost* frame) {
  Profile* profile = Profile::FromBrowserContext(frame->GetBrowserContext());
  return !profile || IsInspectionAllowed(profile, frame);
}

struct ConsoleEntry {
  uint64_t seq = 0;
  bool error = false;
  bool exception = false;
  bool main_frame = false;
  bool withheld = false;
  std::string text;
  std::string source;
  int line = 0;
  double time = 0;
};

class ConsoleRing : public content::WebContentsObserver,
                    public content::WebContentsUserData<ConsoleRing> {
 public:
  ~ConsoleRing() override = default;

  void OnDidAddMessageToConsole(
      content::RenderFrameHost* source_frame,
      blink::mojom::ConsoleMessageLevel log_level,
      const std::u16string& message,
      int32_t line_no,
      const std::u16string& source_id,
      const std::optional<std::u16string>& untrusted_stack_trace) override {
    if (log_level != blink::mojom::ConsoleMessageLevel::kWarning &&
        log_level != blink::mojom::ConsoleMessageLevel::kError) {
      return;
    }
    ConsoleEntry entry;
    entry.seq = ++last_seq_;
    entry.error = log_level == blink::mojom::ConsoleMessageLevel::kError;
    entry.text = Truncated(message, kMaxText);
    entry.exception = entry.error && entry.text.starts_with(kUncaught);
    entry.main_frame =
        source_frame && !source_frame->GetParentOrOuterDocument();
    entry.withheld = !source_frame || !FrameInspectable(source_frame);
    entry.source = Truncated(source_id, kMaxSource);
    entry.line = std::max(0, static_cast<int>(line_no));
    entry.time = base::Time::Now().InMillisecondsFSinceUnixEpoch();
    entries_.push_back(std::move(entry));
    ++Counts().captured;
    if (entries_.size() > kConsoleRingSize) {
      entries_.pop_front();
      ++Counts().evicted;
    }
  }

  base::DictValue Delta(uint64_t after,
                        std::optional<double> generation,
                        size_t limit) const {
    const bool reset =
        (generation && *generation != static_cast<double>(generation_)) ||
        after > last_seq_;
    if (reset) {
      after = 0;
    }
    const uint64_t first =
        entries_.empty() ? last_seq_ + 1 : entries_.front().seq;
    const uint64_t from = std::max(after + 1, first);
    base::ListValue list;
    uint64_t next = after;
    size_t errors = 0;
    size_t withheld = 0;
    for (const ConsoleEntry& entry : entries_) {
      if (entry.seq < from) {
        continue;
      }
      if (list.size() >= limit) {
        break;
      }
      next = entry.seq;
      if (entry.withheld) {
        ++withheld;
        continue;
      }
      errors += entry.error ? 1 : 0;
      list.Append(base::DictValue()
                      .Set("seq", static_cast<double>(entry.seq))
                      .Set("level", entry.error ? "error" : "warning")
                      .Set("exception", entry.exception)
                      .Set("mainFrame", entry.main_frame)
                      .Set("text", entry.text)
                      .Set("source", entry.source)
                      .Set("line", entry.line)
                      .Set("time", entry.time));
    }
    const uint64_t dropped = after + 1 < first ? first - (after + 1) : 0;
    return base::DictValue()
        .Set("entries", std::move(list))
        .Set("generation", static_cast<double>(generation_))
        .Set("reset", reset)
        .Set("next", static_cast<double>(next))
        .Set("last", static_cast<double>(last_seq_))
        .Set("dropped", static_cast<double>(dropped))
        .Set("withheld", static_cast<int>(withheld))
        .Set("errors", static_cast<int>(errors))
        .Set("more", next < last_seq_);
  }

 private:
  explicit ConsoleRing(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<ConsoleRing>(*contents),
        generation_(++LastGeneration()) {
    ++Counts().rings;
  }
  friend class content::WebContentsUserData<ConsoleRing>;

  std::deque<ConsoleEntry> entries_;
  uint64_t last_seq_ = 0;
  const uint64_t generation_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ConsoleRing);

class RingWatcher : public BrowserCollectionObserver,
                    public TabStripModelObserver {
 public:
  static RingWatcher& Get() {
    static base::NoDestructor<RingWatcher> watcher;
    return *watcher;
  }

  void Start() {
    if (started_) {
      return;
    }
    started_ = true;
    GlobalBrowserCollection* browsers = GlobalBrowserCollection::GetInstance();
    observation_.Observe(browsers);
    browsers->ForEach([this](BrowserWindowInterface* browser) {
      Watch(browser);
      return true;
    });
  }

  void OnBrowserCreated(BrowserWindowInterface* browser) override {
    Watch(browser);
  }

  void OnBrowserClosed(BrowserWindowInterface* browser) override {
    if (TabStripModel* model = browser->GetTabStripModel()) {
      model->RemoveObserver(this);
    }
  }

  void OnTabStripModelChanged(
      TabStripModel* model,
      const TabStripModelChange& change,
      const TabStripSelectionChange& selection) override {
    if (change.type() == TabStripModelChange::kInserted) {
      for (const auto& added : change.GetInsert()->contents) {
        WatchConsoleOf(added.contents);
      }
    } else if (change.type() == TabStripModelChange::kReplaced) {
      WatchConsoleOf(change.GetReplace()->new_contents);
    }
  }

 private:
  friend class base::NoDestructor<RingWatcher>;
  RingWatcher() = default;

  void Watch(BrowserWindowInterface* browser) {
    TabStripModel* model = browser->GetTabStripModel();
    if (!model) {
      return;
    }
    model->AddObserver(this);
    for (int i = 0; i < model->count(); ++i) {
      WatchConsoleOf(model->GetWebContentsAt(i));
    }
  }

  bool started_ = false;
  base::ScopedObservation<BrowserCollection, BrowserCollectionObserver>
      observation_{this};
};

}

void InstallCliConsoleRing() {
  RingWatcher::Get().Start();
}

void WatchConsoleOf(content::WebContents* contents) {
  if (contents && !contents->IsBeingDestroyed()) {
    ConsoleRing::CreateForWebContents(contents);
  }
}

bool ContentsInspectable(content::WebContents* contents) {
  return contents && !contents->IsBeingDestroyed() &&
         FrameInspectable(contents->GetPrimaryMainFrame());
}

base::expected<base::DictValue, std::string> ConsoleDelta(
    content::WebContents* contents,
    uint64_t after,
    std::optional<double> generation,
    size_t limit) {
  if (!ContentsInspectable(contents)) {
    return base::unexpected("ardia: DevTools can't inspect this tab");
  }
  ++Counts().reads;
  WatchConsoleOf(contents);
  const ConsoleRing* ring = ConsoleRing::FromWebContents(contents);
  if (!ring) {
    return base::unexpected("ardia: this tab keeps no console ring");
  }
  return ring->Delta(after, generation,
                     std::clamp<size_t>(limit, 1, kConsoleDeltaMax));
}

base::DictValue ConsoleRingTotals() {
  const ConsoleRingCounts& counts = Counts();
  return base::DictValue()
      .Set("captured", Clamped(counts.captured))
      .Set("evicted", Clamped(counts.evicted))
      .Set("reads", Clamped(counts.reads))
      .Set("rings", Clamped(counts.rings));
}

}
