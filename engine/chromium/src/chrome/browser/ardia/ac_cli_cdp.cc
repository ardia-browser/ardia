// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_cdp.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia {
namespace {

constexpr std::string_view kEventPrefix = "{\"method\":\"";
constexpr size_t kMaxQueuedEvents = 4000;
constexpr std::string_view kReplyPrefix = "{\"id\":";
constexpr std::string_view kSessionKey = "\"sessionId\":\"";

std::string SessionIdOf(std::string_view message) {
  const std::string_view tail =
      message.substr(message.size() > 256 ? message.size() - 256 : 0);
  const size_t at = tail.rfind(kSessionKey);
  if (at == std::string_view::npos) {
    return std::string();
  }
  const std::string_view rest = tail.substr(at + kSessionKey.size());
  const size_t end = rest.find('"');
  return end == std::string_view::npos || end > 128
             ? std::string()
             : std::string(rest.substr(0, end));
}

}

std::string CdpErrorText(const base::DictValue& error) {
  const std::string* text = error.FindString("message");
  return text && !text->empty() ? *text : std::string("error");
}

std::unique_ptr<CdpSession> CdpSession::Attach(content::WebContents* contents,
                                               CdpAccess access,
                                               std::string* error) {
  if (!contents || contents->IsBeingDestroyed()) {
    *error = "the tab is gone";
    return nullptr;
  }
  auto session = base::WrapUnique(new CdpSession(access));
  session->host_ = content::DevToolsAgentHost::GetOrCreateFor(contents);
  if (!session->host_ || !session->host_->AttachClient(session.get())) {
    session->host_ = nullptr;
    *error = "can't inspect this tab";
    return nullptr;
  }
  return session;
}

CdpSession::CdpSession(CdpAccess access) : access_(access) {}

CdpSession::~CdpSession() {
  closed_.Reset();
  if (host_) {
    scoped_refptr<content::DevToolsAgentHost> host = std::move(host_);
    host->DetachClient(this);
  }
  FailAll("the DevTools session ended");
}

void CdpSession::Send(std::string_view method,
                      base::DictValue params,
                      CdpDone done,
                      std::string_view session_id,
                      std::optional<base::TimeDelta> timeout) {
  if (!host_) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done),
                                  base::unexpected("the tab's DevTools target "
                                                   "closed")));
    return;
  }
  const int id = next_id_++;
  base::DictValue message;
  message.Set("id", id);
  message.Set("method", method);
  message.Set("params", std::move(params));
  if (!session_id.empty()) {
    message.Set("sessionId", session_id);
  }
  std::optional<std::string> json = base::WriteJson(message);
  if (!json) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(std::move(done), base::unexpected("params aren't JSON")));
    return;
  }
  pending_[id] = std::move(done);
  if (timeout) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&CdpSession::TimedOut, weak_factory_.GetWeakPtr(), id),
        *timeout);
  }
  scoped_refptr<content::DevToolsAgentHost> host = host_;
  host->DispatchProtocolMessage(this, base::as_byte_span(*json));
}

void CdpSession::DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                                         base::span<const uint8_t> message) {
  const std::string_view text = base::as_string_view(message);
  const bool event = text.starts_with(kEventPrefix);
  if (!event && text.size() > access_.max_reply_bytes &&
      text.starts_with(kReplyPrefix)) {
    int id = 0;
    const std::string_view digits = text.substr(kReplyPrefix.size(), 10);
    const size_t end = digits.find_first_not_of("0123456789");
    if (base::StringToInt(digits.substr(0, end), &id)) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&CdpSession::RefuseReply,
                                    weak_factory_.GetWeakPtr(), id,
                                    text.size()));
      return;
    }
  }
  if (event && queued_events_ >= kMaxQueuedEvents) {
    ++dropped_events_;
    return;
  }
  if (event) {
    ++queued_events_;
  }
  if (event && text.size() > access_.max_event_bytes) {
    const std::string_view rest = text.substr(kEventPrefix.size());
    const size_t end = rest.find('"');
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&CdpSession::DeliverCut, weak_factory_.GetWeakPtr(),
                       std::string(rest.substr(
                           0, end == std::string_view::npos ? 0 : end)),
                       SessionIdOf(text), text.size()));
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&CdpSession::Deliver,
                                weak_factory_.GetWeakPtr(), std::string(text)));
}

void CdpSession::RefuseReply(int id, size_t bytes) {
  auto it = pending_.find(id);
  if (it == pending_.end()) {
    return;
  }
  CdpDone done = std::move(it->second);
  pending_.erase(it);
  std::move(done).Run(base::unexpected(
      "the reply is " + base::NumberToString(bytes) +
      " bytes, over the most a socket line carries; ask for less"));
}

void CdpSession::DeliverCut(std::string method,
                            std::string session_id,
                            size_t bytes) {
  queued_events_ = queued_events_ ? queued_events_ - 1 : 0;
  if (event_sink_ && !method.empty() && method.size() <= 128) {
    event_sink_.Run(method, base::DictValue(), session_id, bytes);
  }
}

void CdpSession::Deliver(std::string message) {
  if (message.starts_with(kEventPrefix)) {
    queued_events_ = queued_events_ ? queued_events_ - 1 : 0;
  }
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(message, base::JSON_PARSE_RFC);
  if (!parsed) {
    return;
  }
  if (std::optional<int> id = parsed->FindInt("id")) {
    auto it = pending_.find(*id);
    if (it == pending_.end()) {
      return;
    }
    CdpDone done = std::move(it->second);
    pending_.erase(it);
    if (const base::DictValue* error = parsed->FindDict("error")) {
      std::move(done).Run(base::unexpected(CdpErrorText(*error)));
      return;
    }
    base::DictValue* result = parsed->FindDict("result");
    std::move(done).Run(result ? std::move(*result) : base::DictValue());
    return;
  }
  const std::string* method = parsed->FindString("method");
  if (!method || !event_sink_) {
    return;
  }
  const std::string* session_id = parsed->FindString("sessionId");
  base::DictValue* params = parsed->FindDict("params");
  event_sink_.Run(*method, params ? std::move(*params) : base::DictValue(),
                  session_id ? *session_id : std::string(), message.size());
}

void CdpSession::AgentHostClosed(content::DevToolsAgentHost* agent_host) {
  host_ = nullptr;
  FailAll("the tab's DevTools target closed");
  if (closed_) {
    std::move(closed_).Run("target-closed");
  }
}

bool CdpSession::MayAttachToURL(const GURL& url, bool is_webui) {
  return !is_webui && !CliRefusedUrl(url);
}

bool CdpSession::MayAttachToRenderFrameHost(
    content::RenderFrameHost* render_frame_host) {
  return !CliFrameRefused(render_frame_host);
}

bool CdpSession::IsTrusted() {
  return false;
}

bool CdpSession::MayReadLocalFiles() {
  return access_.local_files;
}

bool CdpSession::MayWriteLocalFiles() {
  return access_.local_files;
}

void CdpSession::TimedOut(int id) {
  auto it = pending_.find(id);
  if (it == pending_.end()) {
    return;
  }
  CdpDone done = std::move(it->second);
  pending_.erase(it);
  std::move(done).Run(base::unexpected("timed out"));
}

void CdpSession::FailAll(const std::string& why) {
  std::map<int, CdpDone> pending = std::move(pending_);
  pending_.clear();
  for (auto& [id, done] : pending) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(done), base::unexpected(why)));
  }
}

}
