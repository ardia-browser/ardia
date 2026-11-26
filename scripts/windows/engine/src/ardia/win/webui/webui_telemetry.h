#ifndef ARDIA_WIN_WEBUI_WEBUI_TELEMETRY_H_
#define ARDIA_WIN_WEBUI_WEBUI_TELEMETRY_H_

#include <memory>
#include <string>
#include <vector>

#include "base/functional/callback.h"

namespace ardia_win::webui {

int& TelemetryInFlight();

int& TelemetryRequestsStarted();

bool TelemetryPostAllowed(const std::string& body, const std::string& key);

class WinTelemetryClient {
 public:
  using PostReply = base::OnceCallback<void(int)>;

  WinTelemetryClient();
  WinTelemetryClient(const WinTelemetryClient&) = delete;
  WinTelemetryClient& operator=(const WinTelemetryClient&) = delete;
  ~WinTelemetryClient();

  void CancelAll();

  void Post(std::string body, const std::string& ingest_key, PostReply reply);

 private:
  class TelemetryPost;

  static void PostStatus(PostReply reply, int status);

  void Finish(TelemetryPost* post, int status);

  std::vector<std::unique_ptr<TelemetryPost>> posts_;
};

}

#endif
