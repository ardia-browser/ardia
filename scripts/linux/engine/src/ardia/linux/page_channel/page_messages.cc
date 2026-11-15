// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/page_channel/page_channel.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/win/tab_state.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

constexpr size_t kMostNotificationFrames = 500;

struct PageReports {
  std::string theme;
  std::string theme_source;
  std::map<std::string, std::string> notification_frames;
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

ardia_win::TabState* HostedState(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state && !state->key().empty() ? state : nullptr;
}

void SendConfig(PageChannel* channel, const std::string& frame_id, bool main) {
  base::DictValue peek;
  channel->CallFrame(frame_id, "peekConfig", Json(base::Value(std::move(peek))));
  base::DictValue config;
  if (main) {
    config.Set("selectionPopover", SelectionPopover());
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
    }
    SendConfig(channel, frame_id, main && kind == "hello");
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
