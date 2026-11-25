// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace {

constexpr size_t kMaxRefEntries = 4000;
constexpr size_t kRefTrim = 1000;

}

RefStore::RefStore(content::WebContents* contents)
    : content::WebContentsUserData<RefStore>(*contents),
      content::WebContentsObserver(contents) {}

RefStore::~RefStore() = default;

std::string RefStore::KeyFrame(const PageModel& model, int frame) const {
  return model.frames[frame].token;
}

std::string RefStore::RefFor(const PageModel& model, int index) {
  const AxItem& item = model.items[index];
  const std::string frame = KeyFrame(model, item.frame);
  ++clock_;
  if (item.dom > 0 && !frame.empty()) {
    auto key = keys_.find({frame, item.dom});
    if (key != keys_.end()) {
      Entry& entry = entries_[key->second];
      entry.role = item.role;
      entry.name = item.name;
      entry.box = item.box;
      entry.used = clock_;
      return key->second;
    }
  }
  std::string ref = base::StrCat({"e", base::NumberToString(next_++)});
  entries_[ref] = Entry{frame, item.dom, item.role, item.name, item.box,
                        clock_};
  if (item.dom > 0 && !frame.empty()) {
    keys_[{frame, item.dom}] = ref;
  }
  Trim();
  return ref;
}

RefStore::Resolved RefStore::Resolve(const std::string& ref,
                                     const PageModel& model) {
  Resolved out;
  auto found = entries_.find(ref);
  if (found == entries_.end()) {
    out.error = base::StrCat({"unknown ref ", ClippedUtf8(ref, 32),
                              "; take a new snapshot"});
    return out;
  }
  Entry& entry = found->second;
  entry.used = ++clock_;
  const int frame = model.FrameWithToken(entry.frame);
  if (frame < 0) {
    out.error = base::StrCat({"ref ", ref,
                              " is stale: its frame is gone or Ardia can't "
                              "reach it; take a new snapshot"});
    return out;
  }
  const int item = model.Find(frame, entry.dom);
  if (item >= 0 && !model.items[item].hidden &&
      model.items[item].role == entry.role) {
    out.item = item;
    out.changed = model.items[item].name != entry.name;
    entry.name = model.items[item].name;
    entry.box = model.items[item].box;
    return out;
  }
  int match = -1;
  int matches = 0;
  for (size_t i = 0; i < model.items.size(); ++i) {
    const AxItem& candidate = model.items[i];
    if (candidate.frame != frame || candidate.hidden ||
        candidate.role != entry.role || candidate.name != entry.name ||
        candidate.name.empty() || candidate.dom <= 0) {
      continue;
    }
    match = static_cast<int>(i);
    ++matches;
  }
  if (matches != 1) {
    out.error = base::StrCat(
        {"ref ", ref, " is stale: ",
         matches ? "more than one " : "no ", entry.role, " named \"",
         ClippedUtf8(entry.name, 80), "\" is in its frame now; take a new snapshot"});
    return out;
  }
  const AxItem& rebound = model.items[match];
  if (entry.dom > 0) {
    keys_.erase({entry.frame, entry.dom});
  }
  entry.dom = rebound.dom;
  entry.box = rebound.box;
  auto old = keys_.find({entry.frame, rebound.dom});
  if (old != keys_.end() && old->second != ref) {
    entries_.erase(old->second);
  }
  keys_[{entry.frame, rebound.dom}] = ref;
  out.item = match;
  out.rebound = true;
  return out;
}

void RefStore::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->HasCommitted() || navigation->IsSameDocument()) {
    return;
  }
  if (navigation->IsInPrimaryMainFrame()) {
    ++generation_;
    keys_.clear();
    entries_.clear();
    return;
  }
  content::RenderFrameHost* frame = navigation->GetRenderFrameHost();
  if (!frame) {
    return;
  }
  const std::string token = frame->GetDevToolsFrameToken().ToString();
  for (auto it = entries_.begin(); it != entries_.end();) {
    if (it->second.frame == token) {
      keys_.erase({token, it->second.dom});
      it = entries_.erase(it);
    } else {
      ++it;
    }
  }
}

void RefStore::Trim() {
  if (entries_.size() <= kMaxRefEntries) {
    return;
  }
  std::vector<std::pair<uint64_t, std::string>> ages;
  for (const auto& [ref, entry] : entries_) {
    ages.emplace_back(entry.used, ref);
  }
  std::sort(ages.begin(), ages.end());
  for (size_t i = 0; i < kRefTrim && i < ages.size(); ++i) {
    auto it = entries_.find(ages[i].second);
    if (it == entries_.end()) {
      continue;
    }
    if (it->second.dom > 0) {
      keys_.erase({it->second.frame, it->second.dom});
    }
    entries_.erase(it);
  }
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(RefStore);

}
