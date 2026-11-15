// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "ardia/linux/host/host.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/page_channel/page_channel.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/win/tab_state.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "base/strings/string_util.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

constexpr size_t kMostNotificationFrames = 500;

constexpr size_t kMostMediaActions = 32;
constexpr base::TimeDelta kLinkDropInterval = base::Seconds(1);

std::optional<std::string> Text(const base::DictValue* dict,
                                const char* key,
                                size_t limit) {
  const std::string* text = dict ? dict->FindString(key) : nullptr;
  if (!text || text->size() > limit) {
    return std::nullopt;
  }
  return *text;
}

bool Finite(const base::DictValue* dict, const char* key, double* out) {
  const base::Value* value = dict ? dict->Find(key) : nullptr;
  if (!value || !(value->is_int() || value->is_double())) {
    return false;
  }
  *out = value->GetDouble();
  return std::isfinite(*out);
}

bool Flag(const base::DictValue* dict, const char* key) {
  return dict && dict->FindBool(key).value_or(false);
}

class NowPlaying {
 public:
  bool empty() const { return frames_.empty(); }

  std::optional<base::DictValue> Note(const std::string& frame,
                                      const base::DictValue* page,
                                      bool main) {
    if (page && !page->empty()) {
      frames_[frame] = Sanitized(*page);
      if (main) {
        main_frames_.insert(frame);
      } else {
        main_frames_.erase(frame);
      }
    } else {
      frames_.erase(frame);
      main_frames_.erase(frame);
    }
    selected_ = page && !page->empty() ? frame
                : frames_.empty()      ? std::string()
                                       : frames_.begin()->first;
    for (const auto& [other, state] : frames_) {
      if (Rank(other) > Rank(selected_)) {
        selected_ = other;
      }
    }
    auto it = frames_.find(selected_);
    if (it == frames_.end()) {
      return std::nullopt;
    }
    return it->second.Clone();
  }

  bool Reset() {
    const bool had = !frames_.empty();
    frames_.clear();
    main_frames_.clear();
    selected_.clear();
    return had;
  }

 private:
  static base::DictValue Sanitized(const base::DictValue& page) {
    const std::string* state = page.FindString("playbackState");
    std::string playback = state && (*state == "none" || *state == "paused" ||
                                     *state == "playing")
                               ? *state
                               : std::string("none");
    base::ListValue actions;
    if (const base::ListValue* asked = page.FindList("actions")) {
      for (const base::Value& action : *asked) {
        if (action.is_string() && action.GetString().size() <= 64 &&
            actions.size() < kMostMediaActions) {
          actions.Append(action.GetString());
        }
      }
    }
    double position = 0;
    double duration = 0;
    double rate = 1;
    double timestamp = 0;
    Finite(&page, "position", &position);
    const bool has_duration =
        Finite(&page, "duration", &duration) && duration >= 0;
    Finite(&page, "playbackRate", &rate);
    Finite(&page, "timestamp", &timestamp);
    std::optional<std::string> artwork = Text(&page, "artwork", 1 << 20);
    base::DictValue out;
    out.Set("title", Text(&page, "title", 1024).value_or(std::string()));
    out.Set("artist", Text(&page, "artist", 1024).value_or(std::string()));
    out.Set("album", Text(&page, "album", 1024).value_or(std::string()));
    out.Set("artwork", artwork ? base::Value(*artwork) : base::Value());
    out.Set("playbackState", playback);
    out.Set("position", std::max(position, 0.0));
    out.Set("duration", has_duration ? base::Value(duration) : base::Value());
    out.Set("playbackRate", rate);
    out.Set("timestamp", timestamp);
    out.Set("hasVideo", Flag(&page, "hasVideo"));
    out.Set("actions", std::move(actions));
    out.Set("controllable", Flag(&page, "controllable"));
    return out;
  }

  int Rank(const std::string& frame) const {
    auto it = frames_.find(frame);
    if (it == frames_.end()) {
      return -1;
    }
    const std::string* playback = it->second.FindString("playbackState");
    return (it->second.FindBool("controllable").value_or(false) ? 4 : 0) +
           (playback && *playback == "playing" ? 2 : 0) +
           (main_frames_.contains(frame) ? 1 : 0);
  }

  std::map<std::string, base::DictValue> frames_;
  std::set<std::string> main_frames_;
  std::string selected_;
};

struct PageReports {
  std::string theme;
  std::string theme_source;
  std::map<std::string, std::string> notification_frames;
  NowPlaying now_playing;
  base::TimeTicks link_drop_at;
};

std::map<std::string, PageReports>& Reports() {
  static base::NoDestructor<std::map<std::string, PageReports>> reports;
  return *reports;
}

bool& SelectionPopover() {
  static bool enabled = true;
  return enabled;
}

std::string Json(const base::Value& value) {
  return base::WriteJson(value).value_or("null");
}

ardia_win::TabState* HostedState(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state && !state->key().empty() ? state : nullptr;
}

bool BlocksAutoplay(content::WebContents* contents) {
  const GURL page = contents->GetLastCommittedURL();
  if (!page.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  HostContentSettingsMap* settings =
      HostContentSettingsMapFactory::GetForProfile(
          Profile::FromBrowserContext(contents->GetBrowserContext()));
  return settings &&
         settings->GetContentSetting(page, page,
                                     ContentSettingsType::AUTOPLAY) ==
             CONTENT_SETTING_BLOCK;
}

void SendConfig(PageChannel* channel,
                const std::string& frame_id,
                bool main,
                bool block_autoplay) {
  base::DictValue peek;
  channel->CallFrame(frame_id, "peekConfig", Json(base::Value(std::move(peek))));
  base::DictValue config;
  if (main) {
    config.Set("selectionPopover", SelectionPopover());
  }
  if (block_autoplay) {
    config.Set("blockAutoplay", true);
  }
  channel->CallFrame(frame_id, "config", Json(base::Value(std::move(config))));
}

std::optional<base::DictValue> SelectionState(const base::DictValue* dict) {
  std::optional<std::string> text = Text(dict, "text", 4000);
  const base::DictValue* rect = dict ? dict->FindDict("rect") : nullptr;
  double x, y, width, height;
  if (!text || !Finite(rect, "x", &x) || !Finite(rect, "y", &y) ||
      !Finite(rect, "width", &width) || !Finite(rect, "height", &height)) {
    return std::nullopt;
  }
  base::DictValue place;
  place.Set("x", x);
  place.Set("y", y);
  place.Set("width", width);
  place.Set("height", height);
  base::DictValue selection;
  selection.Set("text", *text);
  selection.Set("rect", std::move(place));
  return selection;
}

void Notify(ardia_win::TabState* state,
            PageReports& reports,
            const base::DictValue* dict,
            const std::string& frame_id,
            const std::string& origin,
            bool main) {
  std::optional<std::string> id = Text(dict, "id", 128);
  std::optional<std::string> title = Text(dict, "title", 1024);
  if (!id || id->empty() || !title || origin.empty()) {
    return;
  }
  if (reports.notification_frames.size() > kMostNotificationFrames) {
    reports.notification_frames.clear();
  }
  reports.notification_frames[*id] = frame_id;
  std::optional<std::string> icon = Text(dict, "icon", 1 << 20);
  base::DictValue notification;
  notification.Set("id", *id);
  notification.Set("title", *title);
  notification.Set("body", Text(dict, "body", 4096).value_or(std::string()));
  notification.Set("icon", icon ? base::Value(*icon) : base::Value());
  notification.Set("tag", Text(dict, "tag", 1024).value_or(std::string()));
  notification.Set("silent", Flag(dict, "silent"));
  notification.Set("requireInteraction", Flag(dict, "requireInteraction"));
  notification.Set("origin", origin);
  notification.Set("tabId", state->key());
  notification.Set("isMainFrame", main);
  CountLinux("pageNotifications");
  state->Send("notification", std::move(notification));
}

void SetSelectionPopoverVerb(const std::string&,
                             base::DictValue args,
                             ModuleReply reply) {
  SelectionPopover() = args.FindBool("enabled").value_or(true);
  ReplyNull(std::move(reply));
}

}

void HandlePageMessage(content::WebContents* contents,
                       content::RenderFrameHost& frame,
                       const std::string& kind,
                       const std::string& json) {
  ardia_win::TabState* state = HostedState(contents);
  if (!state) {
    return;
  }
  PageChannel* channel = PageChannel::GetOrCreate(contents);
  const bool main = frame.IsInPrimaryMainFrame();
  const std::string frame_id = PageChannel::FrameId(&frame);
  const url::Origin origin = frame.GetLastCommittedOrigin();
  const std::string sender = origin.opaque() ? std::string() : origin.Serialize();
  std::optional<base::Value> parsed =
      base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  const base::DictValue* dict = parsed ? parsed->GetIfDict() : nullptr;
  PageReports& reports = Reports()[state->key()];

  if (kind == "hello" || kind == "peekHello") {
    if (kind == "hello" && main) {
      CountLinux("pageScriptHellos");
      if (reports.now_playing.Reset()) {
        base::DictValue data;
        data.Set("state", base::Value());
        state->Send("nowPlaying", std::move(data));
      }
    }
    SendConfig(channel, frame_id, main && kind == "hello",
               kind == "hello" && BlocksAutoplay(contents));
  } else if (kind == "displayMediaHello") {
    channel->CallFrame(frame_id, "config", "{}");
  } else if (kind == "theme") {
    if (!main || !dict) {
      return;
    }
    reports.theme = Text(dict, "color", 64).value_or(std::string());
    reports.theme_source = Text(dict, "source", 32).value_or(std::string());
    state->NoteNavigation();
  } else if (kind == "scroll" && main) {
    std::optional<std::string> scroll = Text(dict, "state", 8);
    if (scroll && (*scroll == "down" || *scroll == "up" || *scroll == "top")) {
      base::DictValue data;
      data.Set("state", *scroll);
      state->Send("scroll", std::move(data));
    }
  } else if (kind == "selection" && main) {
    base::DictValue data;
    std::optional<base::DictValue> selection = SelectionState(dict);
    data.Set("selection", selection ? base::Value(std::move(*selection))
                                    : base::Value());
    state->Send("selection", std::move(data));
  } else if (kind == "drm" && dict) {
    base::DictValue data;
    data.Set("keySystem",
             Text(dict, "keySystem", 64).value_or(std::string()));
    data.Set("main", main);
    state->Send("protectedMedia", std::move(data));
  } else if (kind == "appBadge" && main && dict && !sender.empty()) {
    double count = 0;
    const bool counted = Finite(dict, "count", &count) && count >= 1;
    base::DictValue data;
    data.Set("origin", sender);
    data.Set("count", counted ? base::Value(std::floor(std::min(count, 1e9)))
                              : base::Value());
    data.Set("flag", !counted && Flag(dict, "flag"));
    state->Send("appBadge", std::move(data));
  } else if (kind == "nowPlaying") {
    std::optional<base::DictValue> playing =
        reports.now_playing.Note(frame_id, dict, main);
    base::DictValue data;
    data.Set("state",
             playing ? base::Value(std::move(*playing)) : base::Value());
    state->Send("nowPlaying", std::move(data));
  } else if (kind == "linkDrop" && main && dict) {
    std::optional<std::string> url = Text(dict, "url", 8192);
    const GURL link(url.value_or(std::string()));
    const base::TimeTicks now = base::TimeTicks::Now();
    if (link.SchemeIsHTTPOrHTTPS() && Host::Get()->Shows(state->key()) &&
        now - reports.link_drop_at > kLinkDropInterval) {
      reports.link_drop_at = now;
      base::DictValue open;
      open.Set("url", link.spec());
      open.Set("disposition", "foreground");
      open.Set("userGesture", true);
      CountLinux("pageLinkDrops");
      state->Send("openWindow", std::move(open));
    }
  } else if (kind == "notification" && dict) {
    Notify(state, reports, dict, frame_id, sender, main);
  } else if (kind == "notificationClose" && dict) {
    std::optional<std::string> id = Text(dict, "id", 128);
    if (!id || id->empty()) {
      return;
    }
    reports.notification_frames.erase(*id);
    base::DictValue data;
    data.Set("id", *id);
    state->Send("notificationClose", std::move(data));
  }
}

bool CallPageChannelMethod(content::WebContents* contents,
                           const std::string& method,
                           const base::DictValue& args) {
  if (method != "notificationAction") {
    return false;
  }
  ardia_win::TabState* state = HostedState(contents);
  const std::string* id = args.FindString("id");
  const std::string* action = args.FindString("action");
  if (!state || !id) {
    return true;
  }
  PageReports& reports = Reports()[state->key()];
  auto frame = reports.notification_frames.find(*id);
  if (frame == reports.notification_frames.end()) {
    return true;
  }
  const std::string frame_id = frame->second;
  const std::string what = action ? *action : std::string();
  if (what != "click") {
    reports.notification_frames.erase(frame);
  }
  base::DictValue call;
  call.Set("id", *id);
  call.Set("action", what);
  PageChannel::GetOrCreate(contents)->CallFrame(
      frame_id, "notification", Json(base::Value(std::move(call))));
  return true;
}

void AmendTabEvent(base::DictValue& event) {
  const std::string* name = event.FindString("name");
  const std::string* key = event.FindString("key");
  base::DictValue* data = event.FindDict("data");
  if (!name || !key || !data) {
    return;
  }
  if (*name == "navigation") {
    auto it = Reports().find(*key);
    if (it != Reports().end() && !it->second.theme.empty()) {
      data->Set("themeColor", it->second.theme);
      data->Set("themeColorSource", it->second.theme_source.empty()
                                        ? base::Value()
                                        : base::Value(it->second.theme_source));
    }
  }
}

void ResetPageReports(content::WebContents* contents, bool gone) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  if (!state || state->key().empty()) {
    return;
  }
  auto it = Reports().find(state->key());
  if (it == Reports().end()) {
    return;
  }
  if (gone) {
    Reports().erase(it);
    return;
  }
  it->second.theme.clear();
  it->second.theme_source.clear();
}

void AddPageChannelVerbs(DomainVerbs& verbs) {
  verbs.Add("webView", "setSelectionPopover",
            base::BindRepeating(&SetSelectionPopoverVerb));
}

}
