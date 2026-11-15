// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/keychain_records.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/files/file_util.h"
#include "base/functional/callback_helpers.h"
#include "base/files/important_file_writer.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/browser_process.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaKeychain";
constexpr char kProbe[] = "ardia keychain probe";

class Keychain {
 public:
  static Keychain& Get() {
    static base::NoDestructor<Keychain> keychain;
    return *keychain;
  }

  void Start() {
    if (started_ || !g_browser_process->os_crypt_async()) {
      return;
    }
    started_ = true;
    g_browser_process->os_crypt_async()->GetInstance(base::BindOnce(
        &Keychain::Ready, base::Unretained(this)));
  }

  void WhenReady(base::OnceClosure run) {
    if (encryptor_) {
      std::move(run).Run();
      return;
    }
    waiting_.push_back(std::move(run));
  }

  void Read(std::string account, ModuleReply reply) {
    WhenReady(base::BindOnce(&Keychain::ReadNow, base::Unretained(this),
                             std::move(account), std::move(reply)));
  }

  void Write(std::string account, std::string secret, ModuleReply reply) {
    WhenReady(base::BindOnce(&Keychain::WriteNow, base::Unretained(this),
                             std::move(account), std::move(secret),
                             std::move(reply)));
  }

  void Remove(std::string account, ModuleReply reply) {
    disk_->PostTaskAndReply(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath path) { base::DeleteFile(path); },
            PathOf(account)),
        base::BindOnce(
            [](ModuleReply reply) { std::move(reply).Run(base::Value(true)); },
            std::move(reply)));
  }

  void Describe(bool with_keyring, ModuleReply reply) {
    WhenReady(base::BindOnce(
        [](Keychain* keychain, bool with_keyring, ModuleReply reply) {
          const std::string name = SealKindName(keychain->available_);
          if (!with_keyring) {
            std::move(reply).Run(base::Value(name));
            return;
          }
          base::DictValue protection;
          protection.Set("backend", name);
          protection.Set("keyring", IsKeyring(keychain->available_));
          std::move(reply).Run(base::Value(std::move(protection)));
        },
        base::Unretained(this), with_keyring, std::move(reply)));
  }

 private:
  friend class base::NoDestructor<Keychain>;

  Keychain()
      : disk_(base::ThreadPool::CreateSequencedTaskRunner(
            {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
             base::TaskShutdownBehavior::BLOCK_SHUTDOWN})) {}

  static base::FilePath PathOf(std::string_view account) {
    return DataDirectory().Append("Keychain").Append(ItemFileName(account));
  }

  void Ready(scoped_refptr<os_crypt_async::Encryptor> encryptor) {
    encryptor_ = std::move(encryptor);
    std::string probe;
    if (encryptor_->IsEncryptionAvailable() &&
        encryptor_->EncryptString(kProbe, &probe)) {
      available_ = SealKindOf(probe);
    }
    Note("keychain", base::StrCat({"secrets are sealed with ",
                                   SealKindName(available_)}));
    for (base::OnceClosure& run : std::exchange(waiting_, {})) {
      std::move(run).Run();
    }
  }

  std::optional<std::string> Seal(const std::string& secret) const {
    std::string ciphertext;
    if (!encryptor_->IsEncryptionAvailable() ||
        !encryptor_->EncryptString(secret, &ciphertext)) {
      return std::nullopt;
    }
    return ciphertext;
  }

  void ReadNow(std::string account, ModuleReply reply) {
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath path) -> std::optional<std::string> {
              std::string text;
              if (!base::ReadFileToString(path, &text)) {
                return std::nullopt;
              }
              return text;
            },
            PathOf(account)),
        base::BindOnce(&Keychain::Opened, base::Unretained(this),
                       std::move(account), std::move(reply)));
  }

  void Opened(std::string account,
              ModuleReply reply,
              std::optional<std::string> text) {
    std::optional<KeychainRecord> record =
        text ? RecordFromJson(*text) : std::nullopt;
    if (!record) {
      if (text) {
        Note("keychain", "a stored secret couldn't be read");
      }
      std::move(reply).Run(base::Value());
      return;
    }
    std::string secret;
    if (!encryptor_->DecryptString(record->ciphertext, &secret)) {
      Note("keychain", base::StrCat({"a secret couldn't be opened (",
                                     record->backend, ")"}));
      std::move(reply).Run(base::Value());
      return;
    }
    const SealKind stored = SealKindOf(record->ciphertext);
    if (NeedsResealing(stored, available_)) {
      if (std::optional<std::string> resealed = Seal(secret)) {
        Note("keychain", base::StrCat({"a secret moved from ",
                                       SealKindName(stored), " to ",
                                       SealKindName(available_)}));
        Store(account, std::move(*resealed), base::DoNothing());
      }
    }
    std::move(reply).Run(base::Value(std::move(secret)));
  }

  void WriteNow(std::string account, std::string secret, ModuleReply reply) {
    std::optional<std::string> sealed = Seal(secret);
    std::fill(secret.begin(), secret.end(), '\0');
    if (!sealed) {
      std::move(reply).Run(ModuleFailure(
          "secrets can't be encrypted on this system", "ERR_LINUX_KEYCHAIN"));
      return;
    }
    Store(account, std::move(*sealed),
          base::BindOnce(
              [](ModuleReply reply, bool written) {
                if (!written) {
                  std::move(reply).Run(ModuleFailure(
                      "the secret couldn't be saved", "ERR_LINUX_KEYCHAIN"));
                  return;
                }
                std::move(reply).Run(base::Value(true));
              },
              std::move(reply)));
  }

  void Store(const std::string& account,
             std::string ciphertext,
             base::OnceCallback<void(bool)> done) {
    KeychainRecord record;
    record.backend = SealKindName(SealKindOf(ciphertext));
    record.ciphertext = std::move(ciphertext);
    disk_->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(
            [](base::FilePath path, std::string json) {
              return base::CreateDirectory(path.DirName()) &&
                     base::ImportantFileWriter::WriteFileAtomically(path, json);
            },
            PathOf(account), RecordJson(record)),
        std::move(done));
  }

  bool started_ = false;
  scoped_refptr<base::SequencedTaskRunner> disk_;
  scoped_refptr<os_crypt_async::Encryptor> encryptor_;
  SealKind available_ = SealKind::kUnknown;
  std::vector<base::OnceClosure> waiting_;
};

}

void RegisterKeychainModule(ModuleRegistry& registry) {
  Keychain::Get().Start();
  registry.Define(kModule)
      .Async("get", AsyncOf([](base::ListValue args, ModuleReply reply) {
               Keychain::Get().Read(StringArg(args, 0), std::move(reply));
             }))
      .Async("set", AsyncOf([](base::ListValue args, ModuleReply reply) {
               Keychain::Get().Write(StringArg(args, 0), StringArg(args, 1),
                                     std::move(reply));
             }))
      .Async("delete", AsyncOf([](base::ListValue args, ModuleReply reply) {
               Keychain::Get().Remove(StringArg(args, 0), std::move(reply));
             }))
      .Async("backend", AsyncOf([](base::ListValue, ModuleReply reply) {
               Keychain::Get().Describe(false, std::move(reply));
             }))
      .Async("protection", AsyncOf([](base::ListValue, ModuleReply reply) {
               Keychain::Get().Describe(true, std::move(reply));
             }));
}

}
