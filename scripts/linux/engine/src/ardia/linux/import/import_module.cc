// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/import_module.h"

#include <sys/stat.h>

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/import/browser_icons.h"
#include "ardia/linux/import/import_core.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/served_files.h"
#include "base/base64.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/synchronization/lock.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/uuid.h"

namespace ardia_linux {

namespace {

using import::ChromiumKeys;
using import::Decrypted;
using import::SecretText;
using import::Snapshot;
using import::Undecrypted;

constexpr char kModule[] = "ArdiaLinuxImport";
constexpr int64_t kLargestRead = 64 << 20;
constexpr double kWebKitEpochOffsetMicros = 11644473600000000.0;
constexpr int kCookieHashPrefixVersion = 24;
constexpr size_t kCookieHashBytes = 32;
constexpr size_t kBatch = 1000;
constexpr size_t kBatchBytes = 3 * 1024 * 1024;
constexpr size_t kMostBrowsers = 64;
constexpr size_t kMostIconNames = 8;

std::optional<double> FromWebKit(double micros) {
  if (!(micros > 0)) {
    return std::nullopt;
  }
  return (micros - kWebKitEpochOffsetMicros) / 1000;
}

std::string Text(const base::DictValue& row, std::string_view name) {
  const base::Value* value = row.Find(name);
  if (!value) {
    return std::string();
  }
  if (value->is_string()) {
    return value->GetString();
  }
  if (value->is_blob()) {
    return std::string(value->GetBlob().begin(), value->GetBlob().end());
  }
  return std::string();
}

double Number(const base::DictValue& row, std::string_view name) {
  const base::Value* value = row.Find(name);
  if (!value) {
    return 0;
  }
  if (value->is_double() || value->is_int()) {
    return value->GetDouble();
  }
  double parsed = 0;
  return base::StringToDouble(Text(row, name), &parsed) ? parsed : 0;
}

void Wipe(std::vector<base::DictValue>& rows) {
  for (base::DictValue& row : rows) {
    base::Value value(std::move(row));
    import::CleanseValue(value);
  }
  rows.clear();
}

struct Vault {
  base::ListValue cookies;
  base::ListValue addresses;
  base::ListValue cards;

  ~Vault() {
    base::Value cookies_value(std::move(cookies));
    base::Value addresses_value(std::move(addresses));
    base::Value cards_value(std::move(cards));
    import::CleanseValue(cookies_value);
    import::CleanseValue(addresses_value);
    import::CleanseValue(cards_value);
  }
};

class ImportHost {
 public:
  static ImportHost& Get() {
    static base::NoDestructor<ImportHost> host;
    return *host;
  }

  base::FilePath home() const { return home_; }

  std::shared_ptr<const ChromiumKeys> KeysFor(const std::string& browser_id) {
    base::AutoLock hold(lock_);
    auto found = keys_.find(browser_id);
    return found == keys_.end() ? nullptr : found->second;
  }

  void SetKeys(const std::string& browser_id, ChromiumKeys keys) {
    base::AutoLock hold(lock_);
    keys_[browser_id] = std::make_shared<const ChromiumKeys>(std::move(keys));
  }

  std::string NewVault(const std::string& join) {
    base::AutoLock hold(lock_);
    if (!join.empty() && vaults_.contains(join)) {
      return join;
    }
    const std::string id = base::Uuid::GenerateRandomV4().AsLowercaseString();
    vaults_[id] = std::make_unique<Vault>();
    return id;
  }

  template <typename Fill>
  void WithVault(const std::string& id, Fill fill) {
    base::AutoLock hold(lock_);
    auto found = vaults_.find(id);
    if (found != vaults_.end()) {
      fill(*found->second);
    }
  }

  std::unique_ptr<Vault> TakeVault(const std::string& id) {
    base::AutoLock hold(lock_);
    auto found = vaults_.find(id);
    if (found == vaults_.end()) {
      return nullptr;
    }
    std::unique_ptr<Vault> vault = std::move(found->second);
    vaults_.erase(found);
    return vault;
  }

  void Forget() {
    base::AutoLock hold(lock_);
    keys_.clear();
    import::Cleanse(primary_password_);
  }

  void UsePrimaryPassword(std::string password) {
    base::AutoLock hold(lock_);
    import::Cleanse(primary_password_);
    primary_password_ = std::move(password);
  }

  std::string PrimaryPassword() {
    base::AutoLock hold(lock_);
    return primary_password_;
  }

  struct HeldSnapshot {
    base::Lock lock;
    std::unique_ptr<Snapshot> snapshot;
  };

  std::string AddSnapshot(std::unique_ptr<Snapshot> snapshot) {
    base::AutoLock hold(lock_);
    const std::string id = base::Uuid::GenerateRandomV4().AsLowercaseString();
    auto held = std::make_shared<HeldSnapshot>();
    held->snapshot = std::move(snapshot);
    snapshots_[id] = std::move(held);
    return id;
  }

  std::shared_ptr<HeldSnapshot> FindSnapshot(const std::string& id) {
    base::AutoLock hold(lock_);
    auto found = snapshots_.find(id);
    return found == snapshots_.end() ? nullptr : found->second;
  }

  void CloseSnapshot(const std::string& id) {
    std::shared_ptr<HeldSnapshot> held;
    {
      base::AutoLock hold(lock_);
      auto found = snapshots_.find(id);
      if (found == snapshots_.end()) {
        return;
      }
      held = std::move(found->second);
      snapshots_.erase(found);
    }
    base::AutoLock using_it(held->lock);
    held->snapshot.reset();
  }

 private:
  friend class base::NoDestructor<ImportHost>;
  ImportHost() {
    const LaunchConfig& config = CurrentLaunchConfig();
    std::string test_home;
    if (config.test_instance) {
      auto found = config.instance.find("importSourceDir");
      if (found != config.instance.end()) {
        test_home = found->second;
      }
    }
    home_ = test_home.empty() ? base::GetHomeDir() : base::FilePath(test_home);
    base::FilePath real = base::MakeAbsoluteFilePath(home_);
    if (!real.empty()) {
      home_ = real;
    }
  }

  base::Lock lock_;
  base::FilePath home_;
  std::map<std::string, std::shared_ptr<const ChromiumKeys>> keys_;
  std::map<std::string, std::unique_ptr<Vault>> vaults_;
  std::map<std::string, std::shared_ptr<HeldSnapshot>> snapshots_;
  std::string primary_password_;
};

ImportHost& Host() {
  return ImportHost::Get();
}

void OnPool(base::OnceCallback<base::Value()> work, ModuleReply reply) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN},
      std::move(work),
      base::BindOnce(
          [](ModuleReply reply, base::Value value) {
            std::move(reply).Run(std::move(value));
          },
          std::move(reply)));
}

template <typename Work>
AsyncMethod Pooled(Work work) {
  return base::BindRepeating(
      [](const Work& work, base::ListValue args, ModuleReply reply) {
        OnPool(base::BindOnce(work, std::move(args)), std::move(reply));
      },
      std::move(work));
}

base::Value List(base::ListValue args) {
  std::optional<base::FilePath> path =
      import::ConfinedPath(Host().home(), StringArg(args, 0));
  if (!path) {
    return base::Value(base::DictValue().Set("denied", true));
  }
  if (!base::DirectoryExists(*path)) {
    return base::Value();
  }
  if (access(path->value().c_str(), R_OK | X_OK) != 0) {
    return base::Value(base::DictValue().Set("denied", true));
  }
  base::ListValue entries;
  base::FileEnumerator found(*path, false,
                             base::FileEnumerator::FILES |
                                 base::FileEnumerator::DIRECTORIES |
                                 base::FileEnumerator::SHOW_SYM_LINKS);
  for (base::FilePath entry = found.Next(); !entry.empty();
       entry = found.Next()) {
    struct stat facts;
    const bool known = stat(entry.value().c_str(), &facts) == 0;
    entries.Append(base::DictValue()
                       .Set("name", entry.BaseName().value())
                       .Set("dir", known && S_ISDIR(facts.st_mode))
                       .Set("size", known ? static_cast<double>(facts.st_size)
                                          : 0.0)
                       .Set("modified",
                            known ? static_cast<double>(facts.st_mtime) * 1000
                                  : 0.0));
  }
  return base::Value(std::move(entries));
}

std::optional<std::string> ReadLimited(const base::FilePath& path,
                                       double largest) {
  std::optional<int64_t> size = base::GetFileSize(path);
  const int64_t limit =
      static_cast<int64_t>(std::min<double>(largest, kLargestRead));
  if (!size || *size > limit) {
    return std::nullopt;
  }
  std::string bytes;
  if (!base::ReadFileToStringWithMaxSize(path, &bytes, limit)) {
    return std::nullopt;
  }
  return bytes;
}

base::Value ReadAs(std::optional<base::FilePath> path,
                   double largest,
                   bool base64) {
  if (!path) {
    return base::Value();
  }
  std::optional<std::string> bytes = ReadLimited(*path, largest);
  if (!bytes) {
    return base::Value();
  }
  if (base64) {
    return base::Value(base::Base64Encode(*bytes));
  }
  return base::Value(base::IsStringUTF8AllowingNoncharacters(*bytes)
                         ? std::move(*bytes)
                         : import::ValidUtf8(*bytes));
}

base::Value Existing(base::ListValue args) {
  base::ListValue found;
  if (const base::ListValue* paths = ListArg(args, 0)) {
    for (const base::Value& value : *paths) {
      if (!value.is_string() || found.size() > 4096) {
        continue;
      }
      std::optional<base::FilePath> path =
          import::ConfinedPath(Host().home(), value.GetString());
      if (path && base::PathExists(*path)) {
        found.Append(value.GetString());
      }
    }
  }
  return base::Value(std::move(found));
}

base::Value BrowserIcons(base::ListValue args) {
  base::ListValue found;
  const base::ListValue* browsers = ListArg(args, 0);
  if (!browsers) {
    return base::Value(std::move(found));
  }
  for (const base::Value& listed : *browsers) {
    if (found.size() == kMostBrowsers) {
      break;
    }
    std::vector<std::string> names;
    if (listed.is_list()) {
      for (const base::Value& name : listed.GetList()) {
        if (name.is_string() && names.size() < kMostIconNames) {
          names.push_back(name.GetString());
        }
      }
    }
    std::optional<base::FilePath> icon =
        import::FindBrowserIcon(Host().home(), base::FilePath("/"), names);
    if (!icon) {
      found.Append(base::Value());
      continue;
    }
    ServeImportImage(*icon, *icon);
    found.Append(icon->value());
  }
  return base::Value(std::move(found));
}

base::Value ServeImage(base::ListValue args) {
  const std::string asked = StringArg(args, 0);
  std::optional<base::FilePath> path =
      import::ConfinedPath(Host().home(), asked);
  if (!path || !import::IsServableImage(base::FilePath(asked)) ||
      !base::PathExists(*path) || base::DirectoryExists(*path)) {
    return base::Value(false);
  }
  ServeImportImage(base::FilePath(asked), *path);
  return base::Value(true);
}

std::unique_ptr<Snapshot> OpenConfined(const std::string& path,
                                       std::string* failure) {
  std::optional<base::FilePath> confined =
      import::ConfinedPath(Host().home(), path);
  if (!confined) {
    *failure = "refused";
    return nullptr;
  }
  return Snapshot::Open(*confined, failure);
}

base::Value Failure(const std::string& failure) {
  return base::Value(base::DictValue().Set("failure", failure));
}

base::Value Query(base::ListValue args) {
  std::string failure;
  std::unique_ptr<Snapshot> snapshot =
      OpenConfined(StringArg(args, 0), &failure);
  if (!snapshot) {
    return Failure(failure);
  }
  const base::ListValue none;
  const base::ListValue* queries = ListArg(args, 1);
  return base::Value(snapshot->Run(queries ? *queries : none));
}

base::Value OpenSnapshot(base::ListValue args) {
  std::string failure;
  std::unique_ptr<Snapshot> snapshot =
      OpenConfined(StringArg(args, 0), &failure);
  if (!snapshot) {
    return Failure(failure);
  }
  return base::Value(
      base::DictValue().Set("id", Host().AddSnapshot(std::move(snapshot))));
}

base::Value QuerySnapshot(base::ListValue args) {
  auto held = Host().FindSnapshot(StringArg(args, 0));
  if (!held) {
    return Failure("closed");
  }
  base::AutoLock using_it(held->lock);
  if (!held->snapshot) {
    return Failure("closed");
  }
  const base::ListValue none;
  const base::ListValue* queries = ListArg(args, 1);
  return base::Value(held->snapshot->Run(queries ? *queries : none));
}

base::Value CloseSnapshot(base::ListValue args) {
  Host().CloseSnapshot(StringArg(args, 0));
  return base::Value();
}

base::Value Unlock(base::ListValue args) {
  const std::string browser = StringArg(args, 0);
  if (!Host().KeysFor(browser)) {
    std::optional<std::string> password =
        import::KeyringPassword(StringArg(args, 1));
    Host().SetKeys(browser, import::KeysFromPassword(password));
    if (password) {
      import::Cleanse(*password);
    }
  }
  return base::Value(
      base::DictValue().Set("unlocked", true).Set("appBound", false));
}

std::shared_ptr<const ChromiumKeys> EnsureKeys(const std::string& browser) {
  if (std::shared_ptr<const ChromiumKeys> keys = Host().KeysFor(browser)) {
    return keys;
  }
  Host().SetKeys(browser, import::KeysFromPassword(std::nullopt));
  return Host().KeysFor(browser);
}

struct Tally {
  int undecryptable = 0;
  int app_bound = 0;
  std::string failure;

  void Count(const Decrypted& decrypted) {
    if (decrypted.reason == Undecrypted::kAppBound) {
      ++app_bound;
    } else if (decrypted.reason == Undecrypted::kUndecryptable) {
      ++undecryptable;
    }
  }

  base::DictValue Into(base::DictValue out) const {
    out.Set("undecryptable", undecryptable);
    out.Set("appBound", app_bound);
    if (!failure.empty()) {
      out.Set("failure", failure);
    }
    return out;
  }
};

base::Value Logins(base::ListValue args) {
  std::shared_ptr<const ChromiumKeys> keys = EnsureKeys(StringArg(args, 0));
  base::ListValue items;
  std::set<std::string> seen;
  Tally tally;
  for (const std::string& file : [&] {
         std::vector<std::string> files;
         if (const base::ListValue* list = ListArg(args, 1)) {
           for (const base::Value& value : *list) {
             if (value.is_string()) {
               files.push_back(value.GetString());
             }
           }
         }
         return files;
       }()) {
    std::string failure;
    std::unique_ptr<Snapshot> db = OpenConfined(file, &failure);
    if (!db) {
      if (tally.failure.empty()) {
        tally.failure = failure;
      }
      continue;
    }
    std::vector<base::DictValue> rows = db->Rows(
        "SELECT origin_url, username_value, password_value, signon_realm, "
        "date_created, date_last_used, times_used FROM logins WHERE "
        "blacklisted_by_user = 0");
    for (const base::DictValue& row : rows) {
      std::string url = Text(row, "origin_url");
      if (url.empty()) {
        url = Text(row, "signon_realm");
      }
      const std::string username = Text(row, "username_value");
      std::string blob = Text(row, "password_value");
      Decrypted decrypted = import::DecryptChromium(blob, *keys);
      import::Cleanse(blob);
      if (!decrypted.value) {
        tally.Count(decrypted);
        continue;
      }
      if (url.empty() || !seen.insert(url + "\n" + username).second) {
        continue;
      }
      base::DictValue item;
      item.Set("url", url);
      item.Set("username", username);
      item.Set("password", import::ValidUtf8(decrypted.value->str()));
      if (std::string realm = Text(row, "signon_realm"); !realm.empty()) {
        item.Set("realm", realm);
      }
      if (auto created = FromWebKit(Number(row, "date_created"))) {
        item.Set("created", *created);
      }
      if (auto last = FromWebKit(Number(row, "date_last_used"))) {
        item.Set("lastUsed", *last);
      }
      if (double times = Number(row, "times_used")) {
        item.Set("timesUsed", times);
      }
      items.Append(std::move(item));
    }
    Wipe(rows);
  }
  return base::Value(
      tally.Into(base::DictValue().Set("items", std::move(items))));
}

base::DictValue CookieOf(const std::string& host_key,
                         std::string name,
                         std::string value,
                         std::string path,
                         bool secure,
                         bool http_only,
                         std::optional<double> expires_ms,
                         int same_site) {
  static constexpr const char* kSameSite[] = {"none", "lax", "strict"};
  base::DictValue cookie;
  cookie.Set("name", std::move(name));
  cookie.Set("value", std::move(value));
  cookie.Set("domain", host_key);
  cookie.Set("path", path.empty() ? "/" : std::move(path));
  cookie.Set("secure", secure);
  cookie.Set("httpOnly", http_only);
  if (expires_ms) {
    cookie.Set("expires", *expires_ms);
  }
  cookie.Set("sameSite", same_site >= 0 && same_site <= 2
                             ? kSameSite[same_site]
                             : "unspecified");
  return cookie;
}

base::Value Cookies(base::ListValue args) {
  std::shared_ptr<const ChromiumKeys> keys = EnsureKeys(StringArg(args, 0));
  std::string failure;
  std::unique_ptr<Snapshot> db = OpenConfined(StringArg(args, 1), &failure);
  Tally tally;
  if (!db) {
    tally.failure = failure;
    return base::Value(
        tally.Into(base::DictValue().Set("count", 0).Set("dropped", 0)));
  }
  std::vector<base::DictValue> meta =
      db->Rows("SELECT value FROM meta WHERE key = 'version'");
  double version = 0;
  if (!meta.empty()) {
    base::StringToDouble(Text(meta[0], "value"), &version);
  }
  std::vector<base::DictValue> rows = db->Rows(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, "
      "is_secure, is_httponly, samesite, has_expires FROM cookies");
  const std::string token = Host().NewVault(std::string());
  base::ListValue cookies;
  int dropped = 0;
  const double now_ms = base::Time::Now().InMillisecondsFSinceUnixEpoch();
  for (const base::DictValue& row : rows) {
    std::string value = Text(row, "value");
    if (value.empty()) {
      std::string blob = Text(row, "encrypted_value");
      Decrypted decrypted = import::DecryptChromium(blob, *keys);
      import::Cleanse(blob);
      if (!decrypted.value) {
        tally.Count(decrypted);
        continue;
      }
      std::string plain = std::move(decrypted.value->str());
      if (version >= kCookieHashPrefixVersion &&
          plain.size() >= kCookieHashBytes && !Text(row, "encrypted_value").empty()) {
        plain.erase(0, kCookieHashBytes);
      }
      value = import::ValidUtf8(plain);
      import::Cleanse(plain);
    }
    const std::string host_key = Text(row, "host_key");
    std::optional<double> expires =
        Number(row, "has_expires") ? FromWebKit(Number(row, "expires_utc"))
                                   : std::nullopt;
    if (host_key.empty() || (expires && *expires < now_ms)) {
      ++dropped;
      import::Cleanse(value);
      continue;
    }
    cookies.Append(CookieOf(host_key, Text(row, "name"), std::move(value),
                            Text(row, "path"), Number(row, "is_secure") != 0,
                            Number(row, "is_httponly") != 0, expires,
                            static_cast<int>(Number(row, "samesite"))));
  }
  Wipe(rows);
  const int count = static_cast<int>(cookies.size());
  Host().WithVault(token, [&](Vault& vault) {
    for (base::Value& cookie : cookies) {
      vault.cookies.Append(std::move(cookie));
    }
  });
  return base::Value(tally.Into(base::DictValue()
                                    .Set("count", count)
                                    .Set("dropped", dropped)
                                    .Set("token", token)));
}

base::Value FirefoxCookies(base::ListValue args) {
  std::string failure;
  std::unique_ptr<Snapshot> db = OpenConfined(StringArg(args, 0), &failure);
  Tally tally;
  if (!db) {
    tally.failure = failure;
    return base::Value(
        tally.Into(base::DictValue().Set("count", 0).Set("dropped", 0)));
  }
  std::vector<base::DictValue> rows = db->Rows(
      "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, "
      "sameSite, originAttributes FROM moz_cookies");
  const std::string token = Host().NewVault(std::string());
  base::ListValue cookies;
  int skipped = 0;
  int dropped = 0;
  const double now = base::Time::Now().InSecondsFSinceUnixEpoch();
  for (const base::DictValue& row : rows) {
    if (!Text(row, "originAttributes").empty()) {
      ++skipped;
      continue;
    }
    const std::string host_key = Text(row, "host");
    const double expiry = Number(row, "expiry");
    const double expires = expiry > 1e11 ? expiry / 1000 : expiry;
    if (host_key.empty() || (expires && expires < now)) {
      ++dropped;
      continue;
    }
    cookies.Append(CookieOf(
        host_key, Text(row, "name"), Text(row, "value"), Text(row, "path"),
        Number(row, "isSecure") != 0, Number(row, "isHttpOnly") != 0,
        expires ? std::optional<double>(expires * 1000) : std::nullopt,
        static_cast<int>(Number(row, "sameSite"))));
  }
  Wipe(rows);
  const int count = static_cast<int>(cookies.size());
  Host().WithVault(token, [&](Vault& vault) {
    for (base::Value& cookie : cookies) {
      vault.cookies.Append(std::move(cookie));
    }
  });
  return base::Value(tally.Into(base::DictValue()
                                    .Set("count", count)
                                    .Set("dropped", dropped)
                                    .Set("skipped", skipped)
                                    .Set("token", token)));
}

base::Value Autofill(base::ListValue args) {
  std::shared_ptr<const ChromiumKeys> keys = EnsureKeys(StringArg(args, 0));
  std::string failure;
  std::unique_ptr<Snapshot> db = OpenConfined(StringArg(args, 1), &failure);
  Tally tally;
  if (!db) {
    tally.failure = failure;
    return base::Value(tally.Into(base::DictValue()
                                      .Set("addresses", 0)
                                      .Set("cards", 0)
                                      .Set("lockedCards", 0)));
  }
  base::ListValue addresses;
  static const std::pair<const char*, int> kTokenFields[] = {
      {"name", 7},   {"organization", 60}, {"street", 77},
      {"city", 33},  {"state", 34},        {"postalCode", 35},
      {"country", 36}, {"phone", 14},      {"email", 9},
  };
  if (db->HasTable("addresses") && db->HasTable("address_type_tokens")) {
    std::map<std::string, std::map<int, std::string>> by_guid;
    for (const base::DictValue& token :
         db->Rows("SELECT guid, type, value FROM address_type_tokens")) {
      by_guid[Text(token, "guid")][static_cast<int>(Number(token, "type"))] =
          Text(token, "value");
    }
    for (auto& [guid, values] : by_guid) {
      base::DictValue address;
      for (const auto& [key, type] : kTokenFields) {
        auto found = values.find(type);
        if (found != values.end() && !found->second.empty()) {
          address.Set(key, found->second);
        }
      }
      if (!address.empty()) {
        addresses.Append(std::move(address));
      }
    }
  } else if (db->HasTable("autofill_profiles")) {
    auto first = [&](std::string_view table, std::string_view column,
                     const std::string& guid) {
      if (!db->HasTable(table)) {
        return std::string();
      }
      std::vector<base::DictValue> found = db->Rows(
          base::StrCat({"SELECT ", column, " AS value FROM ", table,
                        " WHERE guid = ? LIMIT 1"}),
          {guid});
      return found.empty() ? std::string() : Text(found[0], "value");
    };
    for (const base::DictValue& row : db->Rows(
             "SELECT guid, company_name, street_address, city, state, "
             "zipcode, country_code FROM autofill_profiles")) {
      const std::string guid = Text(row, "guid");
      const std::pair<const char*, std::string> entries[] = {
          {"name", first("autofill_profile_names", "full_name", guid)},
          {"organization", Text(row, "company_name")},
          {"street", Text(row, "street_address")},
          {"city", Text(row, "city")},
          {"state", Text(row, "state")},
          {"postalCode", Text(row, "zipcode")},
          {"country", Text(row, "country_code")},
          {"phone", first("autofill_profile_phones", "number", guid)},
          {"email", first("autofill_profile_emails", "email", guid)},
      };
      base::DictValue address;
      for (const auto& [key, value] : entries) {
        if (!value.empty()) {
          address.Set(key, value);
        }
      }
      if (!address.empty()) {
        addresses.Append(std::move(address));
      }
    }
  }
  base::ListValue cards;
  if (db->HasTable("credit_cards")) {
    std::vector<base::DictValue> rows =
        db->Rows("SELECT name_on_card, expiration_month, expiration_year, "
                 "card_number_encrypted FROM credit_cards");
    for (const base::DictValue& row : rows) {
      std::string blob = Text(row, "card_number_encrypted");
      Decrypted decrypted = import::DecryptChromium(blob, *keys);
      import::Cleanse(blob);
      if (!decrypted.value) {
        tally.Count(decrypted);
        continue;
      }
      std::string number;
      for (char c : decrypted.value->str()) {
        if (base::IsAsciiDigit(c)) {
          number.push_back(c);
        }
      }
      if (number.size() < 12) {
        import::Cleanse(number);
        continue;
      }
      base::DictValue card;
      if (std::string name = Text(row, "name_on_card"); !name.empty()) {
        card.Set("name", name);
      }
      if (double month = Number(row, "expiration_month")) {
        card.Set("expMonth", static_cast<int>(month));
      }
      if (double year = Number(row, "expiration_year")) {
        card.Set("expYear", static_cast<int>(year));
      }
      card.Set("number", std::move(number));
      cards.Append(std::move(card));
    }
    Wipe(rows);
  }
  const std::string token = Host().NewVault(StringArg(args, 2));
  const int address_count = static_cast<int>(addresses.size());
  const int card_count = static_cast<int>(cards.size());
  Host().WithVault(token, [&](Vault& vault) {
    for (base::Value& address : addresses) {
      vault.addresses.Append(std::move(address));
    }
    for (base::Value& card : cards) {
      vault.cards.Append(std::move(card));
    }
  });
  return base::Value(tally.Into(base::DictValue()
                                    .Set("addresses", address_count)
                                    .Set("cards", card_count)
                                    .Set("lockedCards", 0)
                                    .Set("token", token)));
}

base::Value FirefoxLogins(base::ListValue args) {
  base::DictValue empty;
  empty.Set("items", base::ListValue());
  empty.Set("undecryptable", 0);
  empty.Set("appBound", 0);
  auto with_error = [&](std::string_view code, std::string_view message) {
    base::DictValue out = empty.Clone();
    out.Set("error",
            base::DictValue().Set("code", code).Set("message", message));
    return base::Value(std::move(out));
  };
  std::optional<base::FilePath> profile =
      import::ConfinedPath(Host().home(), StringArg(args, 0));
  if (!profile) {
    return with_error("notFound", "No saved passwords in this profile");
  }
  std::optional<std::string> json =
      ReadLimited(profile->Append("logins.json"), kLargestRead);
  if (!json) {
    return with_error("notFound", "No saved passwords in this profile");
  }
  std::string failure;
  std::unique_ptr<Snapshot> key4 =
      Snapshot::Open(profile->Append("key4.db"), &failure);
  if (!key4) {
    base::DictValue out = empty.Clone();
    out.Set("failure", failure);
    return base::Value(std::move(out));
  }
  std::string primary = Host().PrimaryPassword();
  import::FirefoxKey key = import::FirefoxKeyFrom(*key4, primary);
  import::Cleanse(primary);
  if (key.locked) {
    return with_error("locked",
                      "Firefox's primary password protects these passwords");
  }
  if (!key.key) {
    return with_error("unreadable", key.error);
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(*json, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return with_error("unreadable", "logins.json isn't readable");
  }
  base::ListValue items;
  int undecryptable = 0;
  if (const base::ListValue* logins = parsed->GetDict().FindList("logins")) {
    for (const base::Value& entry : *logins) {
      const base::DictValue* login = entry.GetIfDict();
      if (!login) {
        continue;
      }
      const std::string* user = login->FindString("encryptedUsername");
      const std::string* pass = login->FindString("encryptedPassword");
      std::optional<SecretText> username =
          user ? import::DecryptLoginField(*user, *key.key) : std::nullopt;
      std::optional<SecretText> password =
          pass ? import::DecryptLoginField(*pass, *key.key) : std::nullopt;
      if (!username || !password) {
        ++undecryptable;
        continue;
      }
      base::DictValue item;
      const std::string* hostname = login->FindString("hostname");
      item.Set("url", hostname ? *hostname : std::string());
      item.Set("username", import::ValidUtf8(username->str()));
      item.Set("password", import::ValidUtf8(password->str()));
      if (const std::string* realm = login->FindString("httpRealm");
          realm && !realm->empty()) {
        item.Set("realm", *realm);
      }
      if (double created = login->FindDouble("timeCreated").value_or(0);
          created > 0) {
        item.Set("created", created);
      }
      if (double used = login->FindDouble("timeLastUsed").value_or(0);
          used > 0) {
        item.Set("lastUsed", used);
      }
      if (double times = login->FindDouble("timesUsed").value_or(0);
          times > 0) {
        item.Set("timesUsed", times);
      }
      items.Append(std::move(item));
    }
  }
  import::CleanseValue(*parsed);
  import::Cleanse(*json);
  base::DictValue out;
  out.Set("items", std::move(items));
  out.Set("undecryptable", undecryptable);
  out.Set("appBound", 0);
  return base::Value(std::move(out));
}

struct Writing {
  std::string profile;
  std::unique_ptr<Vault> vault;
  bool cookies = false;
  bool autofill = false;
  size_t next_cookie = 0;
  base::DictValue counts;
  ModuleReply reply;
};

void EngineCall(const std::string& name,
                const std::string& profile,
                base::DictValue args,
                base::OnceCallback<void(std::optional<base::DictValue>)> done) {
  base::Value wrapped(std::move(args));
  std::string json = base::WriteJson(wrapped).value_or("{}");
  import::CleanseValue(wrapped);
  base::ListValue call;
  call.Append(name);
  call.Append(profile);
  call.Append(std::move(json));
  ModuleRegistry::Get().Call(
      "ArdiaEngineHost", "engineCall", std::move(call),
      base::BindOnce(
          [](base::OnceCallback<void(std::optional<base::DictValue>)> done,
             ModuleResult result) {
            std::optional<base::Value> parsed;
            if (result.has_value() && result->is_string()) {
              parsed = base::JSONReader::Read(result->GetString(),
                                              base::JSON_PARSE_RFC);
            }
            std::move(done).Run(parsed && parsed->is_dict()
                                    ? std::optional(std::move(parsed->GetDict()))
                                    : std::nullopt);
          },
          std::move(done)));
}

void ContinueWriting(std::unique_ptr<Writing> writing);

void Add(base::DictValue& counts, std::string_view key, int value) {
  counts.Set(key, counts.FindInt(key).value_or(0) + value);
}

void ContinueWriting(std::unique_ptr<Writing> writing) {
  base::ListValue& cookies = writing->vault->cookies;
  if (writing->cookies && writing->next_cookie < cookies.size()) {
    base::ListValue batch;
    size_t bytes = 0;
    while (writing->next_cookie < cookies.size() && batch.size() < kBatch &&
           bytes < kBatchBytes) {
      base::Value& cookie = cookies[writing->next_cookie++];
      bytes += base::WriteJson(cookie).value_or("").size();
      batch.Append(cookie.Clone());
    }
    Writing* raw = writing.get();
    EngineCall(
        "ac_cookies_import", raw->profile,
        base::DictValue().Set("cookies", std::move(batch)),
        base::BindOnce(
            [](std::unique_ptr<Writing> writing,
               std::optional<base::DictValue> reply) {
              if (reply) {
                Add(writing->counts, "cookies",
                    reply->FindInt("imported").value_or(0));
                Add(writing->counts, "cookiesRejected",
                    reply->FindInt("rejected").value_or(0));
                Add(writing->counts, "cookiesExisting",
                    reply->FindInt("existing").value_or(0));
              } else {
                writing->counts.Set("error", "the engine refused the cookies");
              }
              ContinueWriting(std::move(writing));
            },
            std::move(writing)));
    return;
  }
  if (writing->autofill && (!writing->vault->addresses.empty() ||
                            !writing->vault->cards.empty())) {
    writing->autofill = false;
    base::DictValue batch;
    batch.Set("addresses", writing->vault->addresses.Clone());
    batch.Set("cards", writing->vault->cards.Clone());
    const std::string profile = writing->profile;
    EngineCall(
        "ac_autofill_import", profile, std::move(batch),
        base::BindOnce(
            [](std::unique_ptr<Writing> writing,
               std::optional<base::DictValue> reply) {
              if (reply && !reply->FindString("error")) {
                Add(writing->counts, "addresses",
                    reply->FindInt("addresses").value_or(0));
                Add(writing->counts, "cards",
                    reply->FindInt("cards").value_or(0));
              } else {
                writing->counts.Set("autofillFailed", 1);
              }
              ContinueWriting(std::move(writing));
            },
            std::move(writing)));
    return;
  }
  ModuleReply reply = std::move(writing->reply);
  base::DictValue counts = std::move(writing->counts);
  writing.reset();
  std::move(reply).Run(base::Value(std::move(counts)));
}

void WriteImported(base::ListValue args, ModuleReply reply) {
  auto writing = std::make_unique<Writing>();
  writing->vault = Host().TakeVault(StringArg(args, 0));
  writing->profile = StringArg(args, 1);
  writing->counts.Set("cookies", 0);
  writing->counts.Set("cookiesRejected", 0);
  writing->counts.Set("cookiesExisting", 0);
  writing->counts.Set("addresses", 0);
  writing->counts.Set("cards", 0);
  if (!writing->vault) {
    writing->counts.Set("error", "nothing to write");
    std::move(reply).Run(base::Value(std::move(writing->counts)));
    return;
  }
  if (const base::ListValue* kinds = ListArg(args, 2)) {
    for (const base::Value& kind : *kinds) {
      writing->cookies |= kind.is_string() && kind.GetString() == "cookies";
      writing->autofill |= kind.is_string() && kind.GetString() == "autofill";
    }
  }
  writing->reply = std::move(reply);
  CountLinux("import_engine_writes");
  ContinueWriting(std::move(writing));
}

}

void RegisterImportHostModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Constant("home", base::Value(Host().home().value()))
      .Async("list", Pooled(&List))
      .Async("readText", Pooled([](base::ListValue args) {
               return ReadAs(
                   import::ConfinedPath(Host().home(), StringArg(args, 0)),
                   NumberArg(args, 1, kLargestRead), false);
             }))
      .Async("readBase64", Pooled([](base::ListValue args) {
               return ReadAs(
                   import::ConfinedPath(Host().home(), StringArg(args, 0)),
                   NumberArg(args, 1, kLargestRead), true);
             }))
      .Async("readTextWithin", Pooled([](base::ListValue args) {
               return ReadAs(import::ConfinedWithin(Host().home(),
                                                    StringArg(args, 0),
                                                    StringArg(args, 1)),
                             NumberArg(args, 2, kLargestRead), false);
             }))
      .Async("readBase64Within", Pooled([](base::ListValue args) {
               return ReadAs(import::ConfinedWithin(Host().home(),
                                                    StringArg(args, 0),
                                                    StringArg(args, 1)),
                             NumberArg(args, 2, kLargestRead), true);
             }))
      .Async("existing", Pooled(&Existing))
      .Async("browserIcons", Pooled(&BrowserIcons))
      .Async("serveImage", Pooled(&ServeImage))
      .Async("query", Pooled(&Query))
      .Async("openSnapshot", Pooled(&OpenSnapshot))
      .Async("querySnapshot", Pooled(&QuerySnapshot))
      .Async("closeSnapshot", Pooled(&CloseSnapshot))
      .Async("unlock", Pooled(&Unlock))
      .Async("logins", Pooled(&Logins))
      .Async("cookies", Pooled(&Cookies))
      .Async("firefoxCookies", Pooled(&FirefoxCookies))
      .Async("firefoxLogins", Pooled(&FirefoxLogins))
      .Async("autofill", Pooled(&Autofill))
      .Async("writeImported", base::BindRepeating(&WriteImported))
      .Async("discard", Pooled([](base::ListValue args) {
               Host().TakeVault(StringArg(args, 0));
               return base::Value();
             }))
      .Async("forget", Pooled([](base::ListValue) {
               Host().Forget();
               return base::Value();
             }))
      .Async("usePrimaryPassword", Pooled([](base::ListValue args) {
               std::string password = StringArg(args, 0);
               for (base::Value& value : args) {
                 import::CleanseValue(value);
               }
               Host().UsePrimaryPassword(std::move(password));
               return base::Value();
             }));
}

}
