// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_CDP_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_CDP_H_

#include <cstddef>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "content/public/browser/devtools_agent_host_client.h"

class GURL;

namespace content {
class DevToolsAgentHost;
class RenderFrameHost;
class WebContents;
}

namespace ardia {

using CdpResult = base::expected<base::DictValue, std::string>;
using CdpDone = base::OnceCallback<void(CdpResult)>;
using CdpEventSink = base::RepeatingCallback<void(const std::string& method,
                                                  base::DictValue params,
                                                  const std::string& session_id,
                                                  size_t bytes)>;

struct CdpAccess {
  bool local_files = false;
  size_t max_event_bytes = 16 * 1024 * 1024;
  size_t max_reply_bytes = 256 * 1024 * 1024;
};

inline constexpr base::TimeDelta kCdpStepDeadline = base::Seconds(10);

class CdpSession : public content::DevToolsAgentHostClient {
 public:
  static std::unique_ptr<CdpSession> Attach(content::WebContents* contents,
                                            CdpAccess access,
                                            std::string* error);

  CdpSession(const CdpSession&) = delete;
  CdpSession& operator=(const CdpSession&) = delete;
  ~CdpSession() override;

  void Send(std::string_view method,
            base::DictValue params,
            CdpDone done,
            std::string_view session_id = {},
            std::optional<base::TimeDelta> timeout = kCdpStepDeadline);
  void SetEventSink(CdpEventSink sink) { event_sink_ = std::move(sink); }
  void SetClosedCallback(base::OnceCallback<void(std::string)> closed) {
    closed_ = std::move(closed);
  }
  bool attached() const { return !!host_; }
  uint64_t TakeDroppedEvents() { return std::exchange(dropped_events_, 0); }
  size_t pending() const { return pending_.size(); }
  base::WeakPtr<CdpSession> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override;
  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool MayAttachToRenderFrameHost(
      content::RenderFrameHost* render_frame_host) override;
  bool IsTrusted() override;
  bool MayReadLocalFiles() override;
  bool MayWriteLocalFiles() override;

 private:
  explicit CdpSession(CdpAccess access);

  void Deliver(std::string message);
  void DeliverCut(std::string method, std::string session_id, size_t bytes);
  void RefuseReply(int id, size_t bytes);
  void TimedOut(int id);
  void FailAll(const std::string& why);

  CdpAccess access_;
  scoped_refptr<content::DevToolsAgentHost> host_;
  int next_id_ = 1;
  std::map<int, CdpDone> pending_;
  CdpEventSink event_sink_;
  size_t queued_events_ = 0;
  uint64_t dropped_events_ = 0;
  base::OnceCallback<void(std::string)> closed_;
  base::WeakPtrFactory<CdpSession> weak_factory_{this};
};

std::string CdpErrorText(const base::DictValue& error);

}

#endif
