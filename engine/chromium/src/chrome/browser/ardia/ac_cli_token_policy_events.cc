// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

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

void ForgetDestroyedTarget(const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  const base::DictValue* params =
      parsed && parsed->is_dict() ? parsed->GetDict().FindDict("params")
                                  : nullptr;
  if (const std::string* target_id =
          params ? params->FindString("targetId") : nullptr) {
    ForgetCliOwnedTarget(*target_id);
  }
}

}

bool TokenClient::FilterEvent(std::string& message) {
  if (revoked_ || draining_) {
    return false;
  }
  std::string_view view(message);
  constexpr std::string_view kEvent = R"({"method":")";
  if (view.starts_with(kEvent)) {
    size_t end = view.find('"', kEvent.size());
    if (end == std::string_view::npos) {
      return kind_ == TokenKind::kCli;
    }
    std::string_view method = view.substr(kEvent.size(), end - kEvent.size());
    if (kind_ == TokenKind::kPlugin) {
      return FilterPluginEvent(method, ReplySession(view), message);
    }
    if (method == "Target.attachedToTarget" ||
        method == "Target.detachedFromTarget") {
      return FilterTargetEvent(method, message);
    }
    if (method == "Target.targetDestroyed") {
      ForgetDestroyedTarget(message);
    } else if (method == "Inspector.targetCrashed" ||
               method == "Inspector.detached") {
      ForgetSessionOf(message);
    }
    return true;
  }
  if (outstanding_.empty()) {
    return kind_ == TokenKind::kCli;
  }
  std::optional<int> id = ParseResponseId(view);
  std::string session;
  if (id) {
    session = std::string(ReplySession(view));
  } else {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(message, base::JSON_PARSE_RFC);
    if (!parsed || !parsed->is_dict()) {
      return kind_ == TokenKind::kCli;
    }
    id = parsed->GetDict().FindInt("id");
    if (!id) {
      return kind_ == TokenKind::kCli;
    }
    if (const std::string* found = parsed->GetDict().FindString("sessionId")) {
      session = *found;
    }
  }
  auto it = outstanding_.find({session, *id});
  if (it == outstanding_.end()) {
    return kind_ == TokenKind::kCli;
  }
  const std::string method = std::move(it->second);
  outstanding_.erase(it);
  SettleCommandState();
  if (method == kInternalCommand) {
    return false;
  }
  if (kind_ == TokenKind::kPlugin && !FilterPluginReply(*id, session, message)) {
    return true;
  }
  if (method.empty()) {
    return true;
  }
  return FilterResponse(method, message);
}

void TokenClient::ForgetSession(const std::string& session) {
  AbandonWheels(session);
  std::erase_if(outstanding_, [&](const auto& entry) {
    return entry.first.first == session;
  });
  SettleCommandState();
}

void TokenClient::ForgetSessionOf(const std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return;
  }
  const std::string* session = parsed->GetDict().FindString("sessionId");
  ForgetSession(session ? *session : std::string());
}

std::vector<std::string> TokenClient::Subtree(
    const std::string& session) const {
  std::vector<std::string> subtree = {session};
  for (size_t next = 0; next < subtree.size(); ++next) {
    for (const auto& [child, parent] : parents_) {
      if (parent == subtree[next]) {
        subtree.push_back(child);
      }
    }
  }
  return subtree;
}

void TokenClient::DropSubtree(const std::string& session) {
  for (const std::string& gone : Subtree(session)) {
    tab_watches_.erase(gone);
    left_.erase(gone);
    targets_.erase(gone);
    parents_.erase(gone);
    ForgetSession(gone);
  }
  NoteSessionsLeft();
}

bool TokenClient::FilterTargetEvent(std::string_view method,
                                    std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  const base::DictValue* event = parsed && parsed->is_dict()
                                     ? &parsed->GetDict()
                                     : nullptr;
  const base::DictValue* params = event ? event->FindDict("params") : nullptr;
  if (!params) {
    return kind_ == TokenKind::kCli;
  }
  const std::string* child = params->FindString("sessionId");
  if (method == "Target.detachedFromTarget") {
    if (!child) {
      return kind_ == TokenKind::kCli;
    }
    const bool known = targets_.contains(*child) || detaching_.contains(*child);
    DropSubtree(*child);
    std::erase_if(detaching_, [&](const auto& entry) {
      return entry.first == *child || entry.second == *child;
    });
    return kind_ == TokenKind::kCli || known;
  }
  const base::DictValue* info = params->FindDict("targetInfo");
  const std::string* target_id = info ? info->FindString("targetId") : nullptr;
  if (!child || !target_id) {
    return kind_ == TokenKind::kCli;
  }
  const std::string* parent = event->FindString("sessionId");
  if (kind_ == TokenKind::kPlugin &&
      !PluginMayAttachToTargetId(*scope_, target_id)) {
    detaching_[*child] = *child;
    SendInternal(parent ? *parent : std::string(), "Target.detachFromTarget",
                 base::DictValue().Set("sessionId", *child));
    return false;
  }
  const std::string child_session = *child;
  targets_[child_session] = *target_id;
  parents_[child_session] = parent ? *parent : std::string();
  if (kind_ != TokenKind::kPlugin) {
    return true;
  }
  told_targets_.insert(*target_id);
  WatchTab(child_session);
  ScrubPluginTargetInfo(*scope_, parsed->GetDict().FindDict("params")
                                     ->FindDict("targetInfo"));
  message = base::WriteJson(*parsed).value_or(std::string());
  return !message.empty();
}

}
}
