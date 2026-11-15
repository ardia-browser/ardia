// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/sync/sync_module.h"

#include <unistd.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/keychain_records.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/owner_check.h"
#include "ardia/linux/sync/sync_crypto.h"
#include "ardia/linux/sync/sync_logins.h"
#include "ardia/linux/sync/sync_phrase.h"
#include "ardia/linux/sync/sync_vault.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/escape.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/platform_util.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "net/base/filename_util.h"
#include "third_party/re2/src/re2/re2.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"

namespace ardia_linux {

namespace {

using sync::Keys;
using sync::Secret;

constexpr char kModule[] = "ArdiaSync";
constexpr char kLocked[] = "Sync isn't set up on this computer.";
constexpr char kUnreadable[] =
    "This computer's sync state couldn't be read safely, so sync is paused to "
    "keep it.";
constexpr char kFolderName[] = "Ardia Sync";
constexpr const char* kCloudFolders[] = {
    "Dropbox",      "Nextcloud", "ownCloud", "OneDrive", "pCloudDrive",
    "Google Drive", "MEGA",      "Sync",     "Syncthing"};

bool ValidAccount(std::string_view account) {
  static const re2::LazyRE2 kAccount = {"[a-z2-7]{1,64}"};
  return re2::RE2::FullMatch(account, *kAccount);
}

std::string OriginalProfile(const std::string& profile) {
  if (!profile.starts_with("incognito")) {
    return profile;
  }
  const size_t at = profile.find('@');
  return at == std::string::npos ? std::string() : profile.substr(at + 1);
}

std::string ToHex(std::string_view bytes) {
  return base::ToLowerASCII(base::HexEncode(bytes));
}

std::optional<Secret> FromHex(std::string_view hex) {
  std::string out;
  if (!base::HexStringToString(hex, &out)) {
    sync::Wipe(out);
    return std::nullopt;
  }
  return Secret(std::move(out));
}

base::FilePath SyncDataFolder() {
  return DataDirectory().Append("Sync");
}

base::FilePath KeyPath(const std::string& account) {
  return SyncDataFolder().Append("sync-key-" + account);
}

base::FilePath KitFolder() {
  return base::FilePath("/tmp").Append(
      base::StrCat({"Ardia Recovery Kit-", base::NumberToString(getuid())}));
}

std::string ReadDeviceName() {
  std::string info;
  if (base::ReadFileToStringWithMaxSize(base::FilePath("/etc/machine-info"),
                                        &info, 64 * 1024)) {
    static const re2::LazyRE2 kPretty = {"(?m)^PRETTY_HOSTNAME=(.*)$"};
    std::string pretty;
    if (re2::RE2::PartialMatch(info, *kPretty, &pretty)) {
      std::string_view trimmed =
          base::TrimString(pretty, "\"'", base::TRIM_ALL);
      trimmed = base::TrimWhitespaceASCII(trimmed, base::TRIM_ALL);
      if (!trimmed.empty()) {
        return std::string(trimmed);
      }
    }
  }
  char host[256] = {};
  if (gethostname(host, sizeof(host) - 1) != 0 || !host[0]) {
    return "This computer";
  }
  return host;
}

struct DefaultFolder {
  std::string path;
  std::string cloud;
};

DefaultFolder FindDefaultFolder(std::string test_folder) {
  if (!test_folder.empty()) {
    return {test_folder, test_folder};
  }
  base::FilePath home = base::GetHomeDir();
  for (const char* name : kCloudFolders) {
    base::FilePath cloud = home.Append(name);
    if (base::PathExists(cloud)) {
      return {cloud.Append(kFolderName).value(), cloud.value()};
    }
  }
  return {};
}

ModuleResult Failed(std::string_view message, std::string_view code = {}) {
  return ModuleFailure(message, code.empty() ? "ERR_LINUX_NATIVE" : code);
}

ModuleResult FromVault(const sync::VaultError& error) {
  return Failed(error.message, error.code);
}

class SyncState {
 public:
  static SyncState& Get() {
    static base::NoDestructor<SyncState> state;
    return *state;
  }

  void Start() {
    work_ = base::ThreadPool::CreateSequencedTaskRunner(
        {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
         base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
    const LaunchConfig& config = CurrentLaunchConfig();
    std::string test_folder;
    if (config.test_instance) {
      auto found = config.instance.find("syncFolder");
      if (found != config.instance.end()) {
        test_folder = found->second;
      }
    }
    work_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](std::string test_folder) {
              base::DeletePathRecursively(KitFolder());
              return std::make_pair(ReadDeviceName(),
                                    FindDefaultFolder(test_folder));
            },
            test_folder),
        base::BindOnce(
            [](std::pair<std::string, DefaultFolder> found) {
              SyncState::Get().device_name_ = std::move(found.first);
              SyncState::Get().default_folder_ = std::move(found.second);
            }));
    if (g_browser_process->os_crypt_async()) {
      g_browser_process->os_crypt_async()->GetInstance(base::BindOnce(
          [](scoped_refptr<os_crypt_async::Encryptor> encryptor) {
            SyncState& state = SyncState::Get();
            std::string probe;
            SealKind kind = SealKind::kUnknown;
            if (encryptor->IsEncryptionAvailable() &&
                encryptor->EncryptString("ardia sync probe", &probe)) {
              kind = SealKindOf(probe);
            }
            state.encryptor_ = std::move(encryptor);
            state.seal_kind_ = kind;
            std::vector<base::OnceClosure> waiting =
                std::move(state.waiting_for_encryptor_);
            for (base::OnceClosure& run : waiting) {
              std::move(run).Run();
            }
          }));
    }
  }

  void WhenEncryptorReady(base::OnceClosure run) {
    if (encryptor_ || !g_browser_process->os_crypt_async()) {
      std::move(run).Run();
      return;
    }
    waiting_for_encryptor_.push_back(std::move(run));
  }

  bool KeyPersists() const { return IsKeyring(seal_kind_); }

  void Set(const std::string& account, Secret entropy) {
    ++generation_;
    std::optional<Keys> keys = Keys::Derive(entropy.view());
    if (!keys) {
      Clear();
      return;
    }
    account_ = account;
    entropy_ = std::make_shared<Secret>(std::move(entropy));
    keys_ = std::make_shared<const Keys>(std::move(*keys));
    local_unreadable_ = false;
  }

  void Clear() {
    ++generation_;
    account_.clear();
    entropy_.reset();
    keys_.reset();
    local_unreadable_ = false;
  }

  bool Still(uint64_t generation) const {
    return keys_ && generation == generation_;
  }

  std::optional<Secret> SaveKey(const std::string& account,
                                const Secret& entropy) {
    if (!ValidAccount(account)) {
      return std::nullopt;
    }
    if (!KeyPersists() || !encryptor_) {
      kept_until_quit_[account] = std::make_shared<Secret>(entropy.str());
      CountLinux("sync_key_kept_in_memory");
      Note("sync", base::StrCat({"no keyring (", SealKindName(seal_kind_),
                                 "): the sync key is kept until Ardia quits"}));
      return Secret(std::string());
    }
    std::string hex = ToHex(entropy.view());
    std::string sealed;
    const bool ok = encryptor_->EncryptString(hex, &sealed);
    sync::Wipe(hex);
    if (!ok) {
      return std::nullopt;
    }
    kept_until_quit_.erase(account);
    base::DictValue stored;
    stored.Set("version", 1);
    stored.Set("backend", SealKindName(SealKindOf(sealed)));
    stored.Set("sealed", sync::Base64(sealed));
    return Secret(base::WriteJson(stored).value_or("{}"));
  }

  std::shared_ptr<Secret> KeptKey(const std::string& account) const {
    auto found = kept_until_quit_.find(account);
    return found == kept_until_quit_.end() ? nullptr : found->second;
  }

  void ForgetKept(const std::string& account) {
    kept_until_quit_.erase(account);
  }

  std::optional<Secret> OpenStoredKey(const std::string& stored_json,
                                      bool* drop) {
    *drop = false;
    std::optional<base::Value> stored =
        base::JSONReader::Read(stored_json, base::JSON_PARSE_RFC);
    const std::string* sealed64 =
        stored && stored->is_dict() ? stored->GetDict().FindString("sealed")
                                    : nullptr;
    std::optional<Secret> sealed =
        sealed64 ? sync::FromBase64(*sealed64) : std::nullopt;
    if (!sealed) {
      return std::nullopt;
    }
    const SealKind kind = SealKindOf(sealed->view());
    if (!IsKeyring(kind)) {
      *drop = true;
      CountLinux("sync_key_without_keyring_dropped");
      Note("sync", base::StrCat({"deleting a sync key sealed without a keyring "
                                 "(",
                                 SealKindName(kind),
                                 "); the recovery phrase unlocks sync again"}));
      return std::nullopt;
    }
    if (!encryptor_) {
      return std::nullopt;
    }
    std::string hex;
    if (!encryptor_->DecryptString(sealed->str(), &hex)) {
      Note("sync", "the sync key couldn't be opened");
      return std::nullopt;
    }
    std::optional<Secret> entropy = FromHex(hex);
    sync::Wipe(hex);
    if (!entropy || entropy->size() != sync::kKeyBytes) {
      return std::nullopt;
    }
    return entropy;
  }

  scoped_refptr<base::SequencedTaskRunner> work() const { return work_; }
  std::shared_ptr<const Keys> keys() const { return keys_; }
  std::shared_ptr<Secret> entropy() const { return entropy_; }
  uint64_t generation() const { return generation_; }
  bool local_unreadable() const { return local_unreadable_; }
  void MarkLocalUnreadable(uint64_t generation) {
    if (generation == generation_) {
      local_unreadable_ = true;
    }
  }
  const std::string& device_name() const { return device_name_; }
  const DefaultFolder& default_folder() const { return default_folder_; }

 private:
  friend class base::NoDestructor<SyncState>;
  SyncState() = default;

  scoped_refptr<base::SequencedTaskRunner> work_;
  scoped_refptr<os_crypt_async::Encryptor> encryptor_;
  std::vector<base::OnceClosure> waiting_for_encryptor_;
  SealKind seal_kind_ = SealKind::kUnknown;
  std::string account_;
  std::shared_ptr<Secret> entropy_;
  std::shared_ptr<const Keys> keys_;
  uint64_t generation_ = 0;
  bool local_unreadable_ = false;
  std::map<std::string, std::shared_ptr<Secret>> kept_until_quit_;
  std::string device_name_ = "This computer";
  DefaultFolder default_folder_;
};

SyncState& State() {
  return SyncState::Get();
}

template <typename Work>
void OnWorkQueue(Work work, ModuleReply reply) {
  State().work()->PostTaskAndReplyWithResult(FROM_HERE, std::move(work),
                                              std::move(reply));
}

std::vector<std::string> StringsOf(const base::ListValue* list) {
  std::vector<std::string> out;
  if (list) {
    for (const base::Value& value : *list) {
      if (value.is_string()) {
        out.push_back(value.GetString());
      }
    }
  }
  return out;
}

void WithKeys(ModuleReply reply,
              base::OnceCallback<ModuleResult(std::shared_ptr<const Keys>)>
                  work) {
  std::shared_ptr<const Keys> keys = State().keys();
  if (!keys) {
    std::move(reply).Run(Failed(kLocked, "locked"));
    return;
  }
  OnWorkQueue(base::BindOnce(std::move(work), std::move(keys)),
              std::move(reply));
}

void SaveAndSet(std::string account,
                Secret entropy,
                base::OnceCallback<void(bool)> done) {
  State().WhenEncryptorReady(base::BindOnce(
      [](std::string account, Secret entropy,
         base::OnceCallback<void(bool)> done) {
        std::optional<Secret> stored = State().SaveKey(account, entropy);
        if (!stored) {
          Note("sync", "the sync key couldn't be saved");
          std::move(done).Run(false);
          return;
        }
        if (stored->empty()) {
          State().Set(account, std::move(entropy));
          std::move(done).Run(true);
          return;
        }
        State().work()->PostTaskAndReplyWithResult(
            FROM_HERE,
            base::BindOnce(
                [](base::FilePath path, Secret stored) {
                  return base::CreateDirectory(path.DirName()) &&
                         base::SetPosixFilePermissions(path.DirName(),
                                                       0700) &&
                         sync::SaveFileDurably(path, stored.view(), 0600);
                },
                KeyPath(account), std::move(*stored)),
            base::BindOnce(
                [](std::string account, Secret entropy,
                   base::OnceCallback<void(bool)> done, bool saved) {
                  if (saved) {
                    State().Set(account, std::move(entropy));
                  } else {
                    Note("sync", "the sync key couldn't be saved");
                  }
                  std::move(done).Run(saved);
                },
                account, std::move(entropy), std::move(done)));
      },
      std::move(account), std::move(entropy), std::move(done)));
}

void CreatePhrase(base::ListValue args, ModuleReply reply) {
  const std::string account = StringArg(args, 0);
  std::optional<Secret> entropy = sync::RandomSecret(sync::kKeyBytes);
  if (!ValidAccount(account) || !entropy) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  SaveAndSet(account, std::move(*entropy),
             base::BindOnce(
                 [](ModuleReply reply, bool saved) {
                   std::move(reply).Run(base::Value(saved));
                 },
                 std::move(reply)));
}

struct ParsedPhrase {
  std::optional<Secret> entropy;
  base::DictValue problem;
};

void EnterPhrase(base::ListValue args, ModuleReply reply) {
  const std::string account = StringArg(args, 0);
  const std::string folder = StringArg(args, 2);
  Secret text(StringArg(args, 1));
  for (base::Value& value : args) {
    sync::CleanseValue(value);
  }
  if (!ValidAccount(account)) {
    std::move(reply).Run(
        base::Value(base::DictValue().Set("error", "keychain")));
    return;
  }
  State().work()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](Secret text, std::string folder) {
            ParsedPhrase parsed;
            auto entropy = sync::EntropyFrom(text.view());
            if (auto* problem = std::get_if<sync::PhraseProblem>(&entropy)) {
              parsed.problem.Set("error", problem->error);
              if (problem->error == "wordCount") {
                parsed.problem.Set("count", static_cast<int>(problem->count));
              }
              if (problem->error == "unknownWord") {
                parsed.problem.Set("word", problem->word);
              }
              return parsed;
            }
            Secret found = std::move(std::get<Secret>(entropy));
            std::optional<Keys> keys = Keys::Derive(found.view());
            if (!keys) {
              parsed.problem.Set("error", "keychain");
              return parsed;
            }
            auto vault = sync::Vault::At(folder, *keys);
            if (!vault.has_value() || !vault->ChainExists()) {
              parsed.problem.Set(
                  "error", sync::HasSyncData(base::FilePath(folder))
                               ? "mismatch"
                               : "noData");
              return parsed;
            }
            parsed.entropy = std::move(found);
            return parsed;
          },
          std::move(text), folder),
      base::BindOnce(
          [](std::string account, ModuleReply reply, ParsedPhrase parsed) {
            if (!parsed.entropy) {
              std::move(reply).Run(base::Value(std::move(parsed.problem)));
              return;
            }
            SaveAndSet(
                account, std::move(*parsed.entropy),
                base::BindOnce(
                    [](ModuleReply reply, bool saved) {
                      std::move(reply).Run(
                          saved ? base::Value(base::DictValue().Set("ok", true))
                                : base::Value(base::DictValue().Set(
                                      "error", "keychain")));
                    },
                    std::move(reply)));
          },
          account, std::move(reply)));
}

void Unlock(base::ListValue args, ModuleReply reply) {
  const std::string account = StringArg(args, 0);
  if (!ValidAccount(account)) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  State().WhenEncryptorReady(base::BindOnce(
      [](std::string account, ModuleReply reply) {
        if (std::shared_ptr<Secret> kept = State().KeptKey(account)) {
          State().Set(account, Secret(kept->str()));
          std::move(reply).Run(base::Value(true));
          return;
        }
        State().work()->PostTaskAndReplyWithResult(
            FROM_HERE,
            base::BindOnce(
                [](base::FilePath path) {
                  std::string stored;
                  if (!base::ReadFileToStringWithMaxSize(path, &stored,
                                                         64 * 1024)) {
                    return std::optional<Secret>();
                  }
                  return std::optional<Secret>(Secret(std::move(stored)));
                },
                KeyPath(account)),
            base::BindOnce(
                [](std::string account, ModuleReply reply,
                   std::optional<Secret> stored) {
                  if (!stored) {
                    std::move(reply).Run(base::Value(false));
                    return;
                  }
                  bool drop = false;
                  std::optional<Secret> entropy =
                      State().OpenStoredKey(stored->str(), &drop);
                  if (drop) {
                    State().work()->PostTask(
                        FROM_HERE,
                        base::GetDeleteFileCallback(KeyPath(account)));
                  }
                  if (!entropy) {
                    std::move(reply).Run(base::Value(false));
                    return;
                  }
                  State().Set(account, std::move(*entropy));
                  std::move(reply).Run(base::Value(true));
                },
                account, std::move(reply)));
      },
      account, std::move(reply)));
}

void Forget(base::ListValue args, ModuleReply reply) {
  const std::string account = StringArg(args, 0);
  State().ForgetKept(account);
  State().Clear();
  if (!ValidAccount(account)) {
    std::move(reply).Run(base::Value());
    return;
  }
  State().work()->PostTaskAndReply(
      FROM_HERE, base::GetDeleteFileCallback(KeyPath(account)),
      base::BindOnce(
          [](ModuleReply reply) { std::move(reply).Run(base::Value()); },
          std::move(reply)));
}

template <typename Run>
void VaultCall(base::ListValue args, ModuleReply reply, Run run) {
  WithKeys(std::move(reply),
           base::BindOnce(
               [](base::ListValue args, Run run,
                  std::shared_ptr<const Keys> keys) -> ModuleResult {
                 auto vault = sync::Vault::At(StringArg(args, 0), *keys);
                 if (!vault.has_value()) {
                   return FromVault(vault.error());
                 }
                 return run(*vault, args);
               },
               std::move(args), std::move(run)));
}

void ChainStatus(base::ListValue args, ModuleReply reply) {
  VaultCall(std::move(args), std::move(reply),
            [](const sync::Vault& vault, const base::ListValue&) {
              return ModuleResult(base::Value(vault.ChainStatus()));
            });
}

void CreateChain(base::ListValue args, ModuleReply reply) {
  VaultCall(std::move(args), std::move(reply),
            [](const sync::Vault& vault, const base::ListValue&) {
              auto created = vault.CreateChain();
              return created.has_value() ? ModuleResult(base::Value())
                                         : FromVault(created.error());
            });
}

void DeleteChain(base::ListValue args, ModuleReply reply) {
  VaultCall(std::move(args), std::move(reply),
            [](const sync::Vault& vault, const base::ListValue&) {
              auto deleted = vault.DeleteChain();
              return deleted.has_value() ? ModuleResult(base::Value())
                                         : FromVault(deleted.error());
            });
}

void WriteScope(base::ListValue args, ModuleReply reply) {
  if (State().local_unreadable()) {
    std::move(reply).Run(Failed(kUnreadable, "unreadable"));
    return;
  }
  const uint64_t generation = State().generation();
  VaultCall(std::move(args),
            base::BindOnce(
                [](uint64_t generation, ModuleReply reply,
                   ModuleResult result) {
                  if (result.has_value() && !State().Still(generation)) {
                    std::move(reply).Run(Failed(kLocked, "locked"));
                    return;
                  }
                  std::move(reply).Run(std::move(result));
                },
                generation, std::move(reply)),
            [](const sync::Vault& vault, const base::ListValue& args) {
              auto id = vault.Write(StringArg(args, 1), StringArg(args, 2));
              return id.has_value() ? ModuleResult(base::Value(*id))
                                    : FromVault(id.error());
            });
}

void ReadScope(base::ListValue args, ModuleReply reply) {
  VaultCall(std::move(args), std::move(reply),
            [](const sync::Vault& vault, const base::ListValue& args) {
              auto listing = vault.Read(StringArg(args, 1),
                                        StringsOf(ListArg(args, 2)),
                                        base::Time::Now());
              return listing.has_value()
                         ? ModuleResult(
                               base::Value(std::move(*listing).ToDict()))
                         : FromVault(listing.error());
            });
}

void RemoveFiles(base::ListValue args, ModuleReply reply) {
  VaultCall(std::move(args), std::move(reply),
            [](const sync::Vault& vault, const base::ListValue& args) {
              auto removed =
                  vault.Remove(StringArg(args, 1), StringsOf(ListArg(args, 2)));
              return removed.has_value() ? ModuleResult(base::Value())
                                         : FromVault(removed.error());
            });
}

void SealLocal(base::ListValue args, ModuleReply reply) {
  if (State().keys() && State().local_unreadable()) {
    std::move(reply).Run(Failed(kUnreadable, "unreadable"));
    return;
  }
  Secret text(StringArg(args, 0));
  for (base::Value& value : args) {
    sync::CleanseValue(value);
  }
  WithKeys(std::move(reply),
           base::BindOnce(
               [](Secret text, std::shared_ptr<const Keys> keys) {
                 std::optional<std::string> sealed =
                     keys->Seal(text.view(), "local", "state");
                 return sealed ? ModuleResult(base::Value(sync::Base64(*sealed)))
                               : Failed("the sync state couldn't be sealed");
               },
               std::move(text)));
}

void OpenLocal(base::ListValue args, ModuleReply reply) {
  std::shared_ptr<const Keys> keys = State().keys();
  const std::string sealed = StringArg(args, 0);
  if (!keys || sealed.empty()) {
    std::move(reply).Run(base::Value());
    return;
  }
  const uint64_t generation = State().generation();
  State().work()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](std::shared_ptr<const Keys> keys, std::string sealed) {
            std::optional<Secret> data = sync::FromBase64(sealed);
            std::optional<Secret> plain =
                data ? keys->Open(data->view(), "local", "state")
                     : std::nullopt;
            if (!plain) {
              return std::make_pair(false, std::optional<std::string>());
            }
            return std::make_pair(true,
                                  sync::HidePasswords(plain->view(), *keys));
          },
          keys, sealed),
      base::BindOnce(
          [](uint64_t generation, ModuleReply reply,
             std::pair<bool, std::optional<std::string>> opened) {
            if (opened.first && !opened.second) {
              State().MarkLocalUnreadable(generation);
            }
            std::move(reply).Run(opened.second ? base::Value(*opened.second)
                                               : base::Value());
          },
          generation, std::move(reply)));
}

void DisclosedWords(std::string reason,
                    base::OnceCallback<void(std::optional<std::vector<std::string>>)>
                        done) {
  std::shared_ptr<Secret> entropy = State().entropy();
  if (!entropy) {
    std::move(done).Run(std::nullopt);
    return;
  }
  const uint64_t generation = State().generation();
  const int presence = OwnerPresence();
  ConfirmDeviceOwner(
      reason, base::BindOnce(
                  [](std::shared_ptr<Secret> entropy, uint64_t generation,
                     int presence,
                     base::OnceCallback<void(
                         std::optional<std::vector<std::string>>)> done,
                     bool granted) {
                    if (!granted || !OwnerStillPresent(presence) ||
                        !State().Still(generation)) {
                      std::move(done).Run(std::nullopt);
                      return;
                    }
                    std::move(done).Run(sync::WordsFor(entropy->view()));
                  },
                  entropy, generation, presence, std::move(done)));
}

base::Value WordsValue(std::optional<std::vector<std::string>> words) {
  if (!words) {
    return base::Value();
  }
  base::ListValue list;
  for (std::string& word : *words) {
    list.Append(std::move(word));
  }
  return base::Value(std::move(list));
}

void RecoveryWords(base::ListValue args, ModuleReply reply) {
  if (!State().keys()) {
    std::move(reply).Run(Failed(kLocked, "locked"));
    return;
  }
  static const std::map<std::string, std::string> kReasons = {
      {"show", "show your sync recovery phrase"},
      {"save", "save your sync recovery kit"},
      {"copy", "copy your sync recovery kit"},
  };
  auto reason = kReasons.find(StringArg(args, 0));
  DisclosedWords(
      reason == kReasons.end() ? kReasons.at("show") : reason->second,
      base::BindOnce(
          [](ModuleReply reply, std::optional<std::vector<std::string>> words) {
            std::move(reply).Run(WordsValue(std::move(words)));
          },
          std::move(reply)));
}

void CopyRecoveryPhrase(base::ListValue args, ModuleReply reply) {
  if (!State().keys()) {
    std::move(reply).Run(Failed(kLocked, "locked"));
    return;
  }
  DisclosedWords(
      "copy your sync recovery phrase",
      base::BindOnce(
          [](ModuleReply reply, std::optional<std::vector<std::string>> words) {
            if (!words) {
              std::move(reply).Run(base::Value());
              return;
            }
            std::u16string joined =
                base::UTF8ToUTF16(base::JoinString(*words, " "));
            {
              ui::ScopedClipboardWriter writer(
                  ui::ClipboardBuffer::kCopyPaste);
              writer.WriteText(joined);
              writer.MarkAsConfidential();
            }
            std::fill(joined.begin(), joined.end(), u'\0');
            std::move(reply).Run(base::Value(true));
          },
          std::move(reply)));
}

void FolderInfo(base::ListValue args, ModuleReply reply) {
  const std::string asked = StringArg(args, 0);
  DefaultFolder fallback = State().default_folder();
  const std::string chosen = asked.empty() ? fallback.path : asked;
  OnWorkQueue(base::BindOnce(
                  [](std::string chosen, DefaultFolder fallback) {
                    sync::FolderState state;
                    if (!chosen.empty() && chosen.starts_with("/")) {
                      state = sync::StateOfFolder(base::FilePath(chosen));
                    }
                    return ModuleResult(base::Value(
                        base::DictValue()
                            .Set("path", chosen)
                            .Set("defaultPath", fallback.path)
                            .Set("iCloudAvailable", !fallback.cloud.empty())
                            .Set("inICloud", false)
                            .Set("exists", state.exists)
                            .Set("writable", state.exists && state.writable)
                            .Set("hasSyncData",
                                 state.exists && state.has_sync_data)));
                  },
                  chosen, std::move(fallback)),
              std::move(reply));
}

void RevealFolder(base::ListValue args, ModuleReply reply) {
  const base::FilePath path(StringArg(args, 0));
  if (path.IsAbsolute() && !CurrentLaunchConfig().background) {
    if (Profile* profile = ProfileManager::GetLastUsedProfileIfLoaded()) {
      platform_util::ShowItemInFolder(profile, path);
    }
  }
  std::move(reply).Run(base::Value());
}

void EngineCall(const std::string& name,
                const std::string& profile,
                Secret json,
                base::OnceCallback<void(std::optional<Secret>)> done) {
  base::ListValue args;
  args.Append(name);
  args.Append(profile);
  args.Append(json.str());
  ModuleRegistry::Get().Call(
      "ArdiaEngineHost", "engineCall", std::move(args),
      base::BindOnce(
          [](base::OnceCallback<void(std::optional<Secret>)> done,
             ModuleResult result) {
            if (!result.has_value() || !result->is_string()) {
              std::move(done).Run(std::nullopt);
              return;
            }
            Secret reply(std::move(result->GetString()));
            std::move(done).Run(std::move(reply));
          },
          std::move(done)));
}

bool Succeeded(const std::optional<Secret>& reply) {
  if (!reply) {
    return false;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(reply->view(), base::JSON_PARSE_RFC);
  const bool ok = parsed && parsed->is_dict() &&
                  parsed->GetDict().FindBool("ok").value_or(false);
  if (parsed) {
    sync::CleanseValue(*parsed);
  }
  return ok;
}

void ReadPasswords(base::ListValue args, ModuleReply reply) {
  std::shared_ptr<const Keys> keys = State().keys();
  if (!keys) {
    std::move(reply).Run(base::Value());
    return;
  }
  const uint64_t generation = State().generation();
  EngineCall(
      "ac_passwords_logins", OriginalProfile(StringArg(args, 0)),
      Secret("{}"),
      base::BindOnce(
          [](std::shared_ptr<const Keys> keys, uint64_t generation,
             ModuleReply reply, std::optional<Secret> logins) {
            if (!logins) {
              std::move(reply).Run(base::Value());
              return;
            }
            State().work()->PostTaskAndReplyWithResult(
                FROM_HERE,
                base::BindOnce(
                    [](std::shared_ptr<const Keys> keys, Secret logins) {
                      return sync::SealedLogins(logins.view(), *keys);
                    },
                    keys, std::move(*logins)),
                base::BindOnce(
                    [](uint64_t generation, ModuleReply reply,
                       std::optional<base::ListValue> sealed) {
                      if (!sealed) {
                        Note("sync", "reading passwords: the engine's logins "
                                     "couldn't be sealed");
                      }
                      std::move(reply).Run(
                          sealed && State().Still(generation)
                              ? base::Value(std::move(*sealed))
                              : base::Value());
                    },
                    generation, std::move(reply)));
          },
          keys, generation, std::move(reply)));
}

void AddPassword(std::string profile,
                 std::string origin,
                 std::string username,
                 std::shared_ptr<Secret> password,
                 base::OnceCallback<void(bool)> done) {
  EngineCall("ac_passwords_add", profile,
             sync::LoginArgs(origin, username, password->view()),
             base::BindOnce(
                 [](base::OnceCallback<void(bool)> done,
                    std::optional<Secret> added) {
                   std::move(done).Run(Succeeded(added));
                 },
                 std::move(done)));
}

void ReplacePassword(std::string profile,
                     std::string origin,
                     std::string username,
                     std::shared_ptr<Secret> password,
                     uint64_t generation,
                     base::OnceCallback<void(bool)> done) {
  EngineCall(
      "ac_passwords_logins", profile, Secret("{}"),
      base::BindOnce(
          [](std::string profile, std::string origin, std::string username,
             std::shared_ptr<Secret> password, uint64_t generation,
             base::OnceCallback<void(bool)> done,
             std::optional<Secret> logins) {
            if (!logins || !State().Still(generation)) {
              std::move(done).Run(false);
              return;
            }
            std::optional<Secret> found =
                sync::SavedPassword(logins->view(), origin, username);
            std::shared_ptr<Secret> previous =
                found ? std::make_shared<Secret>(std::move(*found)) : nullptr;
            EngineCall(
                "ac_passwords_remove", profile,
                sync::LoginArgs(origin, username, std::nullopt),
                base::BindOnce(
                    [](std::string profile, std::string origin,
                       std::string username, std::shared_ptr<Secret> password,
                       std::shared_ptr<Secret> previous, uint64_t generation,
                       base::OnceCallback<void(bool)> done,
                       std::optional<Secret> removed) {
                      if (!Succeeded(removed)) {
                        std::move(done).Run(false);
                        return;
                      }
                      const bool current = State().Still(generation);
                      std::shared_ptr<Secret> chosen =
                          current ? password : previous;
                      if (!chosen) {
                        std::move(done).Run(false);
                        return;
                      }
                      AddPassword(
                          profile, origin, username, chosen,
                          base::BindOnce(
                              [](std::string profile, std::string origin,
                                 std::string username,
                                 std::shared_ptr<Secret> previous,
                                 bool restoring,
                                 base::OnceCallback<void(bool)> done,
                                 bool added) {
                                if (restoring) {
                                  std::move(done).Run(false);
                                  return;
                                }
                                if (added || !previous) {
                                  std::move(done).Run(added);
                                  return;
                                }
                                AddPassword(profile, origin, username,
                                            previous,
                                            base::BindOnce(
                                                [](base::OnceCallback<void(
                                                       bool)> done,
                                                   bool) {
                                                  std::move(done).Run(false);
                                                },
                                                std::move(done)));
                              },
                              profile, origin, username, previous, !current,
                              std::move(done)));
                    },
                    profile, origin, username, password, previous,
                    generation, std::move(done)));
          },
          profile, origin, username, password, generation, std::move(done)));
}

void SavePassword(base::ListValue args, ModuleReply reply) {
  std::shared_ptr<const Keys> keys = State().keys();
  const std::string profile = OriginalProfile(StringArg(args, 0));
  const std::string origin = StringArg(args, 1);
  const std::string username = StringArg(args, 2);
  const std::string sealed = StringArg(args, 3);
  const bool replacing = BoolArg(args, 4);
  std::optional<Secret> opened =
      keys ? keys->OpenPassword(sealed, origin, username) : std::nullopt;
  if (!opened) {
    Note("sync", "a synced password didn't open for its login; not saving it");
    std::move(reply).Run(base::Value(false));
    return;
  }
  const uint64_t generation = State().generation();
  auto password = std::make_shared<Secret>(std::move(*opened));
  auto done = base::BindOnce(
      [](uint64_t generation, ModuleReply reply, bool saved) {
        std::move(reply).Run(base::Value(saved && State().Still(generation)));
      },
      generation, std::move(reply));
  if (replacing) {
    ReplacePassword(profile, origin, username, password, generation,
                    std::move(done));
  } else {
    AddPassword(profile, origin, username, password, std::move(done));
  }
}

void SaveKitFile(base::ListValue args, ModuleReply reply) {
  const base::FilePath path(StringArg(args, 0));
  std::optional<Secret> bytes = sync::FromBase64(StringArg(args, 1));
  for (base::Value& value : args) {
    sync::CleanseValue(value);
  }
  if (!bytes || !path.IsAbsolute() || path.ReferencesParent()) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  OnWorkQueue(base::BindOnce(
                  [](base::FilePath path, Secret bytes) {
                    return ModuleResult(base::Value(
                        sync::SaveFileDurably(path, bytes.view(), 0600)));
                  },
                  path, std::move(*bytes)),
              std::move(reply));
}

void CopyKitFile(base::ListValue args, ModuleReply reply) {
  const std::string name = StringArg(args, 0);
  std::optional<Secret> bytes = sync::FromBase64(StringArg(args, 1));
  for (base::Value& value : args) {
    sync::CleanseValue(value);
  }
  if (!bytes || name.empty() || name.find('/') != std::string::npos ||
      name == "." || name == "..") {
    std::move(reply).Run(base::Value(false));
    return;
  }
  State().work()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](std::string name, Secret bytes) {
            const base::FilePath folder = KitFolder();
            if (!base::CreateDirectory(folder) ||
                !base::SetPosixFilePermissions(folder, 0700)) {
              return base::FilePath();
            }
            const base::FilePath path = folder.Append(name);
            return sync::SaveFileDurably(path, bytes.view(), 0600)
                       ? path
                       : base::FilePath();
          },
          name, std::move(*bytes)),
      base::BindOnce(
          [](ModuleReply reply, base::FilePath path) {
            if (path.empty()) {
              std::move(reply).Run(base::Value(false));
              return;
            }
            const std::string uri = net::FilePathToFileURL(path).spec();
            {
              ui::ScopedClipboardWriter writer(
                  ui::ClipboardBuffer::kCopyPaste);
              writer.WriteFilenames(uri + "\r\n");
              writer.WriteText(base::UTF8ToUTF16(path.value()));
            }
            std::move(reply).Run(base::Value(true));
          },
          std::move(reply)));
}

}

void RegisterSyncModule(ModuleRegistry& registry) {
  State().Start();
  registry.Define(kModule)
      .Sync("newDeviceId", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(sync::NewFileId()));
            }))
      .Sync("deviceName", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(State().device_name()));
            }))
      .Sync("takeFileCounts", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(base::DictValue()
                                                  .Set("placeholders", 0)
                                                  .Set("busy", 0)
                                                  .Set("hydrated", 0)));
            }))
      .Sync("keyPersists", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(State().KeyPersists()));
            }))
      .Async("folderInfo", base::BindRepeating(&FolderInfo))
      .Async("createPhrase", base::BindRepeating(&CreatePhrase))
      .Async("enterPhrase", base::BindRepeating(&EnterPhrase))
      .Async("unlock", base::BindRepeating(&Unlock))
      .Async("forget", base::BindRepeating(&Forget))
      .Async("chainStatus", base::BindRepeating(&ChainStatus))
      .Async("createChain", base::BindRepeating(&CreateChain))
      .Async("deleteChain", base::BindRepeating(&DeleteChain))
      .Async("write", base::BindRepeating(&WriteScope))
      .Async("read", base::BindRepeating(&ReadScope))
      .Async("remove", base::BindRepeating(&RemoveFiles))
      .Async("sealLocal", base::BindRepeating(&SealLocal))
      .Async("openLocal", base::BindRepeating(&OpenLocal))
      .Async("recoveryWords", base::BindRepeating(&RecoveryWords))
      .Async("copyRecoveryPhrase", base::BindRepeating(&CopyRecoveryPhrase))
      .Async("revealFolder", base::BindRepeating(&RevealFolder))
      .Async("readPasswords", base::BindRepeating(&ReadPasswords))
      .Async("savePassword", base::BindRepeating(&SavePassword))
      .Async("saveKitFile", base::BindRepeating(&SaveKitFile))
      .Async("copyKitFile", base::BindRepeating(&CopyKitFile));
}

}
