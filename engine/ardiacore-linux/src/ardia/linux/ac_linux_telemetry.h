#ifndef ARDIA_LINUX_AC_LINUX_TELEMETRY_H_
#define ARDIA_LINUX_AC_LINUX_TELEMETRY_H_

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"

namespace ardia::linux_telemetry {

using PostReply = base::OnceCallback<void(int status)>;

bool RequestIdAcceptable(std::string_view request_id);

class TelemetryPost;

class TelemetryClient {
 public:
  TelemetryClient();
  TelemetryClient(const TelemetryClient&) = delete;
  TelemetryClient& operator=(const TelemetryClient&) = delete;
  ~TelemetryClient();

  void Post(std::string body, const std::string& ingest_key,
            std::string request_id, PostReply reply);
  void Cancel(const std::string& request_id);

 private:
  friend class TelemetryPost;
  using Posts = std::vector<std::unique_ptr<TelemetryPost>>;

  void Finish(TelemetryPost* post, int status);
  Posts::iterator Held(const std::string& request_id);

  Posts posts_;
};

}

#endif
