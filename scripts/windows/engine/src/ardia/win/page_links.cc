#include "ardia/win/page_links.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <string_view>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/host.h"
#include "ardia/win/main.h"
#include "ardia/win/page_links_internal.h"
#include "ardia/win/tab_calls.h"
#include "ardia/win/tab_state.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/types/event_type.h"
#include "url/origin.h"

namespace ardia_win {

namespace links {

int& ConfigGeneration() {
  static int generation = 0;
  return generation;
}

MouseUp& LastUp() {
  static base::NoDestructor<MouseUp> up;
  return *up;
}

}

namespace {

using namespace links;

constexpr base::TimeDelta kNewTabLinkLifetime = base::Seconds(2);
constexpr size_t kNewTabLinksKept = 4;

struct LinkKeys {
  std::string peek = "shift";
  std::string split = "altShift";
  std::set<std::string> other_site_pages;
};

LinkKeys& Keys() {
  static base::NoDestructor<LinkKeys> keys;
  return *keys;
}

std::set<PageLinks*>& Live() {
  static base::NoDestructor<std::set<PageLinks*>> live;
  return *live;
}

int KeysOf(int flags) {
  int keys = 0;
  if (flags & ui::EF_ALT_DOWN) {
    keys |= kAlt;
  }
  if (flags & ui::EF_SHIFT_DOWN) {
    keys |= kShift;
  }
  if (flags & ui::EF_CONTROL_DOWN) {
    keys |= kControl;
  }
  if (flags & ui::EF_COMMAND_DOWN) {
    keys |= kMeta;
  }
  return keys;
}

std::string SplitLinkKey() {
  return Keys().split == "alt" && Keys().peek != "alt" ? "alt" : "altShift";
}

}

namespace links {

int LinkKeyFlags(const std::string& key) {
  if (key == "alt") {
    return kAlt;
  }
  if (key == "shift") {
    return kShift;
  }
  if (key == "altShift") {
    return kAlt | kShift;
  }
  if (key == "altMeta") {
    return kAlt | kMeta;
  }
  return 0;
}

std::string LinkKeyAction(const std::string& key) {
  if (!LinkKeyFlags(key)) {
    return "";
  }
  if (key == Keys().peek) {
    return "peek";
  }
  if (key == "altShift" || key == "altMeta" || key == SplitLinkKey()) {
    return "split";
  }
  return "";
}

std::string Field(const base::DictValue& dict,
                  std::string_view key,
                  size_t longest) {
  const std::string* value = dict.FindString(key);
  if (!value || value->size() > longest) {
    return "";
  }
  return *value;
}

bool Finite(const base::DictValue& dict, std::string_view key, double* out) {
  std::optional<double> value = dict.FindDouble(key);
  if (!value || !std::isfinite(*value)) {
    return false;
  }
  *out = *value;
  return true;
}

bool Web(const GURL& url) {
  return url.is_valid() && url.SchemeIsHTTPOrHTTPS();
}

bool ScriptableDocument(content::RenderFrameHost* frame) {
  const GURL& url = frame->GetLastCommittedURL();
  return url.SchemeIsHTTPOrHTTPS() || url.SchemeIsFile();
}

base::DictValue PointValue(gfx::PointF point) {
  base::DictValue value;
  value.Set("x", point.x());
  value.Set("y", point.y());
  return value;
}

}

PageLinks::PageLinks(content::WebContents* contents)
    : content::WebContentsUserData<PageLinks>(*contents) {
  Live().insert(this);
}

PageLinks::~PageLinks() {
  Live().erase(this);
  if (host_) {
    host_->DetachClient(this);
  }
}

void PageLinks::Watch(content::WebContents* contents) {
  if (PageLinks::FromWebContents(contents)) {
    return;
  }
  PageLinks::CreateForWebContents(contents);
  if (contents->GetPrimaryMainFrame()->IsRenderFrameLive()) {
    PageLinks::FromWebContents(contents)->Attach();
  }
}

void PageLinks::RendererReady() {
  Attach();
}

void PageLinks::Configure(const base::DictValue& args) {
  if (const std::string* peek = args.FindString("peek")) {
    Keys().peek = *peek == "alt" || *peek == "shift" ? *peek : "off";
  }
  if (const std::string* split = args.FindString("split")) {
    Keys().split = *split == "alt" ? "alt" : "altShift";
  }
  if (const base::ListValue* pages = args.FindList("otherSitePages")) {
    Keys().other_site_pages.clear();
    for (const base::Value& page : *pages) {
      if (page.is_string()) {
        Keys().other_site_pages.insert(page.GetString());
      }
    }
  }
  ++ConfigGeneration();
  for (PageLinks* links : Live()) {
    links->PushConfig();
  }
}

base::DictValue PageLinks::Config() {
  base::DictValue config;
  config.Set("peek", Keys().peek);
  config.Set("split", SplitLinkKey());
  base::ListValue pages;
  for (const std::string& page : Keys().other_site_pages) {
    pages.Append(page);
  }
  config.Set("otherSitePages", std::move(pages));
  return config;
}

void PageLinks::NoteMouse(const ui::MouseEvent& event,
                          const std::string& page) {
  if (!(event.changed_button_flags() & ui::EF_LEFT_MOUSE_BUTTON)) {
    return;
  }
  MouseUp& up = LastUp();
  if (event.type() == ui::EventType::kMousePressed) {
    up.pressed_since = true;
    return;
  }
  if (event.type() != ui::EventType::kMouseReleased) {
    return;
  }
  up.keys = KeysOf(event.flags());
  up.at = base::TimeTicks::Now();
  up.page = page;
  up.point = event.root_location_f();
  up.pressed_since = false;
  ++up.seq;
}

std::optional<gfx::PointF> PageLinks::RecentClickPoint(
    const std::string& page) {
  const MouseUp& up = LastUp();
  if (page.empty() || up.page != page || !up.at ||
      base::TimeTicks::Now() - *up.at > kGestureLifetime) {
    return std::nullopt;
  }
  return up.point;
}

std::string PageLinks::PageKey() {
  TabState* state = TabState::FromWebContents(&GetWebContents());
  return state ? state->key() : std::string();
}

bool PageLinks::PeeksOtherSites() {
  const std::string key = PageKey();
  return !key.empty() && Keys().other_site_pages.contains(key);
}

std::string PageLinks::ConfigJson() {
  base::DictValue config;
  config.Set("modifier", Keys().peek);
  config.Set("split", SplitLinkKey());
  config.Set("otherSites", PeeksOtherSites());
  return base::WriteJson(config).value_or("{}");
}

void PageLinks::Heard(int context, const std::string& payload) {
  auto found = contexts_.find(context);
  content::RenderFrameHost* frame =
      found == contexts_.end() ? nullptr
                               : ActiveFrameWithToken(found->second.frame_token);
  std::optional<base::DictValue> message =
      base::JSONReader::ReadDict(payload, base::JSON_PARSE_RFC);
  const std::string* kind = message ? message->FindString("kind") : nullptr;
  const base::DictValue* data = message ? message->FindDict("data") : nullptr;
  const char* outcome = !kind || !data      ? "unreadable"
                        : !frame            ? "from a context with no active frame"
                        : !ScriptableDocument(frame)
                            ? "from a document not on http(s) or file"
                            : "heard";
  NoteReportForTest(kind ? *kind : std::string(),
                    data ? Field(*data, "url", kLongestUrl) : std::string(),
                    outcome);
  if (std::string_view(outcome) != "heard") {
    return;
  }
  if (*kind == "peek") {
    PeekLink(*data, context, frame->IsInPrimaryMainFrame());
  } else if (*kind == "newTabLink") {
    NoteNewTabLink(*data);
  }
}

void PageLinks::NoteNewTabLink(const base::DictValue& data) {
  const GURL url(Field(data, "url", kLongestUrl));
  if (!Web(url)) {
    return;
  }
  DropStaleNewTabLinks();
  new_tab_links_.push_back(NewTabLink{url, base::TimeTicks::Now()});
  if (new_tab_links_.size() > kNewTabLinksKept) {
    new_tab_links_.erase(new_tab_links_.begin());
  }
}

void PageLinks::DropStaleNewTabLinks() {
  const base::TimeTicks now = base::TimeTicks::Now();
  std::erase_if(new_tab_links_, [now](const NewTabLink& link) {
    return now - link.at > kNewTabLinkLifetime;
  });
}

bool PageLinks::TakeNewTabLink(const std::vector<GURL>& urls) {
  DropStaleNewTabLinks();
  for (auto it = new_tab_links_.begin(); it != new_tab_links_.end(); ++it) {
    if (std::find(urls.begin(), urls.end(), it->url) != urls.end()) {
      new_tab_links_.erase(it);
      return true;
    }
  }
  return false;
}

OpenRequest::OpenRequest(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<OpenRequest>(*contents) {}

OpenRequest::~OpenRequest() = default;

void OpenRequest::Note(content::WebContents* opened) {
  if (opened && !OpenRequest::FromWebContents(opened)) {
    OpenRequest::CreateForWebContents(opened);
  }
}

void OpenRequest::DidStartNavigation(content::NavigationHandle* handle) {
  if (started_ || !handle->IsInPrimaryMainFrame() || !Web(handle->GetURL())) {
    return;
  }
  started_ = true;
  gesture_ = handle->HasUserGesture();
  form_ = handle->IsFormSubmission();
  url_ = handle->GetURL();
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(PageLinks);
WEB_CONTENTS_USER_DATA_KEY_IMPL(OpenRequest);

}
