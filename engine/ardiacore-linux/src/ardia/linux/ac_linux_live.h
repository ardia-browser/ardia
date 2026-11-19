#ifndef ARDIA_LINUX_AC_LINUX_LIVE_H_
#define ARDIA_LINUX_AC_LINUX_LIVE_H_

#include <compare>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/linux/ac_linux_sync_json.h"
#include "ardia/linux/ac_linux_sync_keystore.h"

namespace ardia::linux_live {

using linux_sync::JsonValue;
using linux_sync::KeyStatus;

enum class Source { kGithub, kBitbucket, kNotion, kConfluence, kGdrive };

inline constexpr Source kSources[] = {Source::kGithub, Source::kBitbucket, Source::kNotion, Source::kConfluence,
                                      Source::kGdrive};

inline constexpr const char* kMethods[] = {"ArdiaLive.request", "ArdiaLive.connect", "ArdiaLive.cancel",
                                           "ArdiaLive.disconnect", "ArdiaLive.legacy"};

inline constexpr char kSecretSchema[] = "dev.ardia.linux.LiveToken";
inline constexpr char kSecretLabel[] = "Ardia Live Folder Token";
inline constexpr char kKeyDirectory[] = "Ardia Live Tokens";
inline constexpr char kGoogleRedirect[] = "http://127.0.0.1:53682/ardia-oauth";
inline constexpr char kNotionVersion[] = "2022-06-28";

inline constexpr size_t kMaxCredentialBytes = 16 * 1024;
inline constexpr size_t kMaxFieldBytes = 4096;
inline constexpr size_t kMaxQueryBytes = 16 * 1024;
inline constexpr size_t kMaxReplyBytes = 8 * 1024 * 1024;
inline constexpr size_t kMaxErrorTextBytes = 200;
inline constexpr size_t kMaxActive = 8;
inline constexpr size_t kMaxQueued = 256;
inline constexpr size_t kMaxRequestIdBytes = 160;
inline constexpr size_t kMaxProfileIdBytes = 128;
inline constexpr int kTimeoutSeconds = 20;
inline constexpr int64_t kRenewalMarginMs = 60000;

inline constexpr char kErrArgument[] = "ERR_LIVE_ARGUMENT";
inline constexpr char kErrBusy[] = "ERR_LIVE_BUSY";
inline constexpr char kErrCancelled[] = "ERR_LIVE_CANCELLED";
inline constexpr char kErrNotConnected[] = "ERR_LIVE_NOT_CONNECTED";
inline constexpr char kErrSignedOut[] = "ERR_LIVE_SIGNED_OUT";
inline constexpr char kErrSso[] = "ERR_LIVE_SSO";
inline constexpr char kErrRateLimited[] = "ERR_LIVE_RATE_LIMITED";
inline constexpr char kErrNetwork[] = "ERR_LIVE_NETWORK";
inline constexpr char kErrService[] = "ERR_LIVE_SERVICE";
inline constexpr char kErrKeyringLocked[] = "ERR_LIVE_KEYRING_LOCKED";
inline constexpr char kErrKeyringUnavailable[] = "ERR_LIVE_KEYRING_UNAVAILABLE";
inline constexpr char kErrUnknownCall[] = "ERR_UNKNOWN_CALL";

std::optional<Source> SourceFrom(std::string_view name);
std::string_view SourceName(Source source);

struct Account {
  Source source = Source::kGithub;
  std::string profile;
  auto operator<=>(const Account& other) const = default;
};

bool ValidProfileId(std::string_view id);
std::string AccountName(const Account& account);
bool IsLiveMethod(std::string_view method);
bool ValidRequestId(std::string_view id);
bool ValidLiveAccount(std::string_view account);
const linux_sync::KeySchema& LiveKeySchema();

struct Credential {
  Credential() = default;
  Credential(const Credential& other) = default;
  Credential& operator=(const Credential& other) = default;
  ~Credential();

  Source source = Source::kGithub;
  std::string profile;
  std::string token;
  std::string user;
  std::string site;
  std::string client_id;
  std::string client_secret;
  std::string refresh_token;
  int64_t expires_at_ms = 0;
};

std::string SerializeCredential(const Credential& credential);
std::optional<Credential> ParseCredential(Source source, std::string_view text);
bool ValidCredential(const Credential& credential);
bool SameCredential(const Credential& a, const Credential& b);
Account AccountOf(const Credential& credential);

KeyStatus LoadCredential(linux_sync::KeyStore& store, const Account& account, std::optional<Credential>* credential);
KeyStatus SaveCredential(linux_sync::KeyStore& store, const Credential& credential);
KeyStatus DeleteCredential(linux_sync::KeyStore& store, const Account& account);

struct HttpRequest {
  std::string id;
  std::string method;
  std::string url;
  std::vector<std::pair<std::string, std::string>> headers;
  std::string content_type;
  std::string body;
};

inline constexpr const char* kResponseHeaders[] = {"x-github-sso", "x-ratelimit-remaining", "retry-after"};

struct HttpResponse {
  bool reached = false;
  bool too_large = false;
  int status = 0;
  std::map<std::string, std::string> headers;
  std::string body;
};

struct Outcome {
  static Outcome Value(JsonValue value);
  static Outcome Error(std::string code, std::string message);

  bool ok = true;
  JsonValue value;
  std::string code;
  std::string message;
};

struct ProviderContract {
  std::string viewer_query;
  std::string github_scope;
  std::string notion_search_body;
  std::string notion_version;
  std::string confluence_cql;
  std::vector<std::pair<std::string, std::string>> drive_query;
  std::string google_redirect;
};

ProviderContract Contract();
std::optional<std::string> NormalizeSite(std::string_view site);
bool ReadOnlyGraphql(std::string_view query);
std::string PercentEncode(std::string_view text);
std::string Base64(std::string_view text);
std::string ErrorText(int status, std::string_view body);
std::optional<Outcome> Failure(const HttpResponse& response);
std::optional<HttpRequest> BuildRequest(Source source, std::string_view operation, const JsonValue& params,
                                        const Credential* credential, std::string* error);
bool NeedsCredential(Source source, std::string_view operation);

class Transport {
 public:
  using Done = std::function<void(HttpResponse)>;
  virtual ~Transport() = default;
  virtual void Send(HttpRequest request, Done done) = 0;
  virtual void Cancel(const std::string& id) = 0;
};

class CredentialStore {
 public:
  using Loaded = std::function<void(KeyStatus, std::optional<Credential>)>;
  using Stored = std::function<void(KeyStatus)>;
  virtual ~CredentialStore() = default;
  virtual void Load(Account account, Loaded done) = 0;
  virtual void Save(Credential credential, Stored done) = 0;
  virtual void Delete(Account account, Stored done) = 0;
};

class LiveCore {
 public:
  using Reply = std::function<void(Outcome)>;
  using Clock = std::function<int64_t()>;

  LiveCore(Transport& transport, CredentialStore& store, Clock now_ms);
  LiveCore(const LiveCore&) = delete;
  LiveCore& operator=(const LiveCore&) = delete;
  ~LiveCore();

  void Invoke(std::string_view method, const std::vector<JsonValue>& args, Reply reply);
  void CancelCaller(std::string_view caller);

  size_t active() const { return active_.size(); }
  size_t queued() const { return queue_.size(); }
  size_t calls() const { return calls_.size(); }

 private:
  using Access = std::function<void(std::optional<Outcome>, const Credential*)>;
  using Handler = std::function<void(HttpResponse)>;

  struct Call {
    std::string id;
    Account account;
    Reply reply;
    std::optional<std::string> transfer;
  };

  struct Cached {
    enum class State { kUnknown, kLoading, kPresent, kAbsent };
    State state = State::kUnknown;
    std::optional<Credential> credential;
    uint64_t generation = 0;
    uint32_t saving = 0;
    std::vector<Access> waiters;
  };

  struct Queued {
    uint64_t owner = 0;
    HttpRequest request;
    Handler handler;
  };

  void Request(Account account, std::string operation, JsonValue params, std::string id, Reply reply);
  void Connect(Account account, JsonValue fields, std::string id, Reply reply);
  void Cancel(const std::string& id, Reply reply);
  void Disconnect(Account account, Reply reply);
  void LegacyExists(Source source, Reply reply);
  void AdoptLegacy(Account account, Reply reply);

  uint64_t Open(std::string id, Account account, Reply reply);
  bool Alive(uint64_t serial) const;
  void Finish(uint64_t serial, Outcome outcome);
  void Send(uint64_t owner, HttpRequest request, Handler handler);
  void Pump();
  void Drop(const std::string& transfer);

  void WithCredential(const Account& account, Access access);
  void WithAccess(const Account& account, uint64_t serial, Access access);
  void Renew(const Account& account);
  void FinishRenewal(const Account& account, std::optional<Outcome> failure);
  void Commit(uint64_t serial, Credential candidate, std::function<void(const Credential&)> committed);

  void Issue(uint64_t serial, Account account, std::string operation, JsonValue params, bool retried);
  void Verify(uint64_t serial, Credential candidate);
  void ConnectGithubDevice(uint64_t serial, Account account, std::string client_id, std::string device_code);
  void ConnectGoogle(uint64_t serial, Credential candidate, std::string code, std::string verifier);

  Transport& transport_;
  CredentialStore& store_;
  Clock now_ms_;
  uint64_t next_serial_ = 0;
  uint64_t next_transfer_ = 0;
  std::map<uint64_t, Call> calls_;
  std::map<std::string, uint64_t> ids_;
  std::map<Account, Cached> cache_;
  std::deque<std::pair<std::string, Queued>> queue_;
  std::map<std::string, Queued> active_;
  std::map<Account, std::vector<Access>> renewals_;
};

}

#endif
