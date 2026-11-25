// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <vector>
#include <string_view>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_owned_tabs.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

std::string_view ReplySession(std::string_view view) {
  constexpr std::string_view kKey = R"(,"sessionId":")";
  if (view.size() < kKey.size() + 2 || !view.ends_with("\"}")) {
    return std::string_view();
  }
  const size_t end = view.size() - 2;
  const size_t open = view.rfind('"', end - 1);
  if (open == std::string_view::npos || open + 1 < kKey.size() ||
      view.substr(open + 1 - kKey.size(), kKey.size()) != kKey) {
    return std::string_view();
  }
  return view.substr(open + 1, end - open - 1);
}

std::optional<int> ParseResponseId(std::string_view view) {
  constexpr std::string_view kResponse = R"({"id":)";
  if (!view.starts_with(kResponse)) {
    return std::nullopt;
  }
  size_t end = kResponse.size();
  if (end < view.size() && view[end] == '-') {
    ++end;
  }
  while (end < view.size() && base::IsAsciiDigit(view[end])) {
    ++end;
  }
  int id = 0;
  if (end >= view.size() || (view[end] != ',' && view[end] != '}') ||
      !base::StringToInt(view.substr(kResponse.size(), end - kResponse.size()),
                         &id)) {
    return std::nullopt;
  }
  return id;
}

std::optional<base::DictValue> ParseObject(const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(parsed->GetDict());
}

}

bool TokenClient::FilterEvent(std::string& message) {
  std::string_view view(message);
  constexpr std::string_view kEvent = R"({"method":")";
  if (view.starts_with(kEvent)) {
    const size_t end = view.find('"', kEvent.size());
    if (end == std::string_view::npos) {
      return true;
    }
    const std::string_view method =
        view.substr(kEvent.size(), end - kEvent.size());
    if (method == "Target.attachedToTarget" ||
        method == "Target.detachedFromTarget" ||
        method == "Target.targetDestroyed") {
      NoteTargetEvent(method, message);
    }
    return true;
  }
  if (outstanding_.empty()) {
    return true;
  }
  std::optional<int> id = ParseResponseId(view);
  std::string session;
  if (id) {
    session = std::string(ReplySession(view));
  } else {
    std::optional<base::DictValue> parsed = ParseObject(message);
    if (!parsed) {
      return true;
    }
    id = parsed->FindInt("id");
    if (!id) {
      return true;
    }
    if (const std::string* found = parsed->FindString("sessionId")) {
      session = *found;
    }
  }
  auto it = outstanding_.find({session, *id});
  if (it == outstanding_.end()) {
    return true;
  }
  const std::string method = std::move(it->second);
  outstanding_.erase(it);
  if (method.empty()) {
    return true;
  }
  return FilterResponse(*id, method, message);
}

void TokenClient::ForgetSession(const std::string& session) {
  std::erase_if(outstanding_, [&](const auto& entry) {
    return entry.first.first == session;
  });
  std::erase_if(running_, [&](const auto& entry) {
    return entry.first.first == session;
  });
}

void TokenClient::ForgetSessionTree(const std::string& session) {
  std::vector<std::string> pending = {session};
  while (!pending.empty()) {
    const std::string current = std::move(pending.back());
    pending.pop_back();
    for (const auto& [child, parent] : parents_) {
      if (parent == current) {
        pending.push_back(child);
      }
    }
    targets_.erase(current);
    parents_.erase(current);
    ForgetSession(current);
  }
}

void TokenClient::NoteTargetEvent(std::string_view method,
                                  const std::string& message) {
  std::optional<base::DictValue> event = ParseObject(message);
  if (!event) {
    return;
  }
  const base::DictValue* params = event->FindDict("params");
  const std::string* event_session = event->FindString("sessionId");
  if (!params) {
    return;
  }
  if (method == "Target.targetDestroyed") {
    if (const std::string* target_id = params->FindString("targetId")) {
      ForgetCliOwnedTarget(*target_id);
    }
    return;
  }
  const std::string* child = params->FindString("sessionId");
  if (!child) {
    return;
  }
  if (method == "Target.detachedFromTarget") {
    ForgetSessionTree(*child);
    return;
  }
  const base::DictValue* info = params->FindDict("targetInfo");
  const std::string* target_id = info ? info->FindString("targetId") : nullptr;
  if (target_id) {
    targets_[*child] = *target_id;
    parents_[*child] = event_session ? *event_session : std::string();
  }
}

bool TokenClient::FilterResponse(int id,
                                 const std::string& method,
                                 std::string& message) {
  std::optional<base::DictValue> response = ParseObject(message);
  if (!response) {
    return true;
  }
  base::DictValue* result = response->FindDict("result");
  if (!result) {
    return true;
  }
  if (method == "Target.createTarget") {
    if (const std::string* target_id = result->FindString("targetId")) {
      NoteCliOwnedTarget(*target_id);
    }
    return true;
  }
  bool annotated = false;
  if (method == "Target.getTargets") {
    if (base::ListValue* infos = result->FindList("targetInfos")) {
      for (base::Value& info : *infos) {
        if (info.is_dict() &&
            IsOffscreenTarget(info.GetDict().FindString("targetId"))) {
          info.GetDict().Set("ardiaOffscreen", true);
          annotated = true;
        }
      }
    }
  } else if (method == "Target.getTargetInfo") {
    base::DictValue* info = result->FindDict("targetInfo");
    if (info && IsOffscreenTarget(info->FindString("targetId"))) {
      info->Set("ardiaOffscreen", true);
      annotated = true;
    }
  }
  if (annotated) {
    std::optional<std::string> rewritten = base::WriteJson(*response);
    if (rewritten) {
      message = std::move(*rewritten);
    }
  }
  return true;
}

}
}
