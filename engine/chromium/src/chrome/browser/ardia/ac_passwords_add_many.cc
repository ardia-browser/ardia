// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/ardia/ac_sensitive_args.h"
#include "chrome/browser/password_manager/factories/account_password_store_factory.h"
#include "chrome/browser/password_manager/factories/profile_password_store_factory.h"
#include "components/keyed_service/core/service_access_type.h"
#include "components/password_manager/core/browser/features/password_features.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_manager_util.h"
#include "components/password_manager/core/browser/password_store/password_store_backend_error.h"
#include "components/password_manager/core/browser/password_store/password_store_consumer.h"
#include "components/password_manager/core/browser/password_store/password_store_interface.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "components/password_manager/core/browser/password_string.h"
#include "url/gurl.h"

namespace ardia {
namespace {

using password_manager::PasswordForm;
using password_manager::PasswordStoreBackendError;
using password_manager::PasswordStoreInterface;
using password_manager::StoredCredential;
using Credentials = std::vector<StoredCredential>;
using CredentialsOrError = base::expected<Credentials, PasswordStoreBackendError>;
using Key = std::pair<std::string, std::u16string>;

constexpr size_t kMaxBatchArgsBytes = 16 * 1024 * 1024;
constexpr size_t kMaxBatchEntries = 20000;
constexpr size_t kMaxOriginBytes = 2048;
constexpr size_t kMaxUsernameBytes = 1024;
constexpr size_t kMaxPasswordBytes = 4096;
constexpr size_t kMaxNoteBytes = 4096;
constexpr base::TimeDelta kAddTimeout = base::Seconds(60);

enum class Row { kInvalid, kExists, kPending, kAdded, kFailed };

struct NewLogin {
  NewLogin() = default;
  NewLogin(NewLogin&&) = default;
  NewLogin& operator=(NewLogin&&) = default;
  ~NewLogin() { Cleanse(password); }

  Row row = Row::kInvalid;
  std::string realm;
  GURL url;
  std::u16string username;
  std::u16string password;
  std::u16string note;
};

bool HasControl(std::string_view text) {
  return std::ranges::any_of(text, [](char c) {
    const unsigned char byte = static_cast<unsigned char>(c);
    return byte < 0x20 || byte == 0x7f;
  });
}

const std::string* BoundedString(const base::DictValue& entry,
                                 std::string_view key,
                                 size_t limit,
                                 bool* bad) {
  const base::Value* value = entry.Find(key);
  if (!value) {
    return nullptr;
  }
  if (!value->is_string() || value->GetString().size() > limit) {
    *bad = true;
    return nullptr;
  }
  return &value->GetString();
}

NewLogin Parse(const base::Value& item) {
  NewLogin login;
  const base::DictValue* entry = item.GetIfDict();
  if (!entry) {
    return login;
  }
  bool bad = false;
  const std::string* origin = BoundedString(*entry, "origin", kMaxOriginBytes, &bad);
  const std::string* username =
      BoundedString(*entry, "username", kMaxUsernameBytes, &bad);
  const std::string* note = BoundedString(*entry, "note", kMaxNoteBytes, &bad);
  const base::Value* plain = entry->Find("password");
  const base::Value* hex = entry->Find("passwordHex");
  if (bad || !origin || HasControl(*origin) ||
      (username && HasControl(*username)) || (plain && !plain->is_string()) ||
      (hex && !hex->is_string()) || (!plain && !hex)) {
    return login;
  }
  std::optional<Secret> password = SecretIn(*entry, "password");
  if (!password || password->value().empty() ||
      password->value().size() > kMaxPasswordBytes ||
      !base::IsStringUTF8(password->value())) {
    return login;
  }
  const GURL url = password_manager_util::StripAuthAndParams(
      password_manager_util::ConstructGURLWithScheme(*origin));
  if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS()) {
    return login;
  }
  login.row = Row::kPending;
  login.url = url;
  login.realm = password_manager_util::GetSignonRealm(url);
  login.username = username ? base::UTF8ToUTF16(*username) : std::u16string();
  login.password = base::UTF8ToUTF16(password->value());
  login.note = note ? base::UTF8ToUTF16(*note) : std::u16string();
  return login;
}

StoredCredential Stored(const NewLogin& login) {
  StoredCredential added;
  added.scheme = PasswordForm::Scheme::kHtml;
  added.url = login.url;
  added.signon_realm = login.realm;
  added.username_value = login.username;
  std::u16string copy = login.password;
  added.password_value = password_manager::PasswordString(std::move(copy));
  added.type = PasswordForm::Type::kImported;
  added.date_created = base::Time::Now();
  added.date_password_modified = added.date_created;
  added.in_store = PasswordForm::Store::kProfileStore;
  if (!login.note.empty()) {
    added.notes.emplace_back(login.note, added.date_created);
  }
  return added;
}

void Forget(Credentials& credentials) {
  for (StoredCredential& credential : credentials) {
    credential.password_value.clear();
  }
}

class AddsState;

class AddMany : public password_manager::PasswordStoreConsumer {
 public:
  AddMany(AddsState& owner,
          Reply reply,
          scoped_refptr<PasswordStoreInterface> store,
          scoped_refptr<PasswordStoreInterface> account_store,
          std::vector<NewLogin> logins)
      : owner_(owner),
        reply_(std::move(reply)),
        store_(std::move(store)),
        account_store_(std::move(account_store)),
        logins_(std::move(logins)) {}

  ~AddMany() override {
    if (!settled_) {
      reply_.Error("closed");
    }
  }

  void Start() {
    timeout_.Start(FROM_HERE, kAddTimeout,
                   base::BindOnce(&AddMany::Finish, weak_factory_.GetWeakPtr(),
                                  std::string_view("The password store didn't answer")));
    Read(Step::kWrite);
  }

  void OnGetPasswordStoreResultsOrErrorFrom(PasswordStoreInterface* from,
                                            CredentialsOrError result) override {
    if (!result.has_value()) {
      return Finish("unreadable");
    }
    for (StoredCredential& credential : *result) {
      read_.push_back(std::move(credential));
    }
    if (--reads_left_ > 0) {
      return;
    }
    if (step_ == Step::kWrite) {
      Write(read_);
    } else {
      Verify(read_);
    }
    Forget(read_);
    read_.clear();
  }

 private:
  enum class Step { kWrite, kVerify };

  void Read(Step step) {
    step_ = step;
    const bool both = step == Step::kWrite && account_store_;
    reads_left_ = both ? 2 : 1;
    store_->GetAllLogins(weak_factory_.GetWeakPtr());
    if (both) {
      account_store_->GetAllLogins(weak_factory_.GetWeakPtr());
    }
  }

  void Write(const Credentials& credentials) {
    std::set<Key> saved;
    for (const StoredCredential& credential : credentials) {
      saved.insert({credential.signon_realm, credential.username_value});
    }
    Credentials adds;
    for (NewLogin& login : logins_) {
      if (login.row != Row::kPending) {
        continue;
      }
      if (!saved.insert({login.realm, login.username}).second) {
        login.row = Row::kExists;
        continue;
      }
      adds.push_back(Stored(login));
    }
    if (adds.empty()) {
      return Finish({});
    }
    store_->AddLogins(std::move(adds),
                      base::BindOnce(&AddMany::Read, weak_factory_.GetWeakPtr(),
                                     Step::kVerify));
  }

  void Verify(const Credentials& credentials) {
    std::map<Key, const StoredCredential*> saved;
    for (const StoredCredential& credential : credentials) {
      saved[{credential.signon_realm, credential.username_value}] = &credential;
    }
    for (NewLogin& login : logins_) {
      if (login.row != Row::kPending) {
        continue;
      }
      auto found = saved.find({login.realm, login.username});
      login.row = found != saved.end() &&
                          found->second->password_value == login.password
                      ? Row::kAdded
                      : Row::kFailed;
    }
    Finish({});
  }

  void Finish(std::string_view error);

  const raw_ref<AddsState> owner_;
  Reply reply_;
  bool settled_ = false;
  scoped_refptr<PasswordStoreInterface> store_;
  scoped_refptr<PasswordStoreInterface> account_store_;
  std::vector<NewLogin> logins_;
  Credentials read_;
  int reads_left_ = 0;
  Step step_ = Step::kWrite;
  base::OneShotTimer timeout_;
  base::WeakPtrFactory<AddMany> weak_factory_{this};
};

class AddsState : public ProfileState {
 public:
  explicit AddsState(Profile* profile) : ProfileState(profile) {}

  void Start(Reply reply,
             scoped_refptr<PasswordStoreInterface> store,
             scoped_refptr<PasswordStoreInterface> account_store,
             std::vector<NewLogin> logins) {
    adds_.push_back(std::make_unique<AddMany>(
        *this, std::move(reply), std::move(store), std::move(account_store),
        std::move(logins)));
    if (adds_.size() == 1) {
      adds_.front()->Start();
    }
  }

  void Done(AddMany* add) {
    auto found = std::ranges::find_if(
        adds_, [add](const auto& owned) { return owned.get() == add; });
    if (found == adds_.end()) {
      return;
    }
    const bool was_running = found == adds_.begin();
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                               std::move(*found));
    adds_.erase(found);
    if (was_running && !adds_.empty()) {
      adds_.front()->Start();
    }
  }

 private:
  void Release() override { adds_.clear(); }

  std::vector<std::unique_ptr<AddMany>> adds_;
};

const char* RowName(Row row) {
  switch (row) {
    case Row::kInvalid:
      return "invalid";
    case Row::kExists:
      return "exists";
    case Row::kAdded:
      return "added";
    case Row::kPending:
    case Row::kFailed:
      return "failed";
  }
}

void AddMany::Finish(std::string_view error) {
  if (settled_) {
    return;
  }
  settled_ = true;
  weak_factory_.InvalidateWeakPtrs();
  timeout_.Stop();
  if (!error.empty()) {
    reply_.Error(error);
  } else {
    base::ListValue results;
    int added = 0;
    int existing = 0;
    int invalid = 0;
    int failed = 0;
    for (const NewLogin& login : logins_) {
      results.Append(RowName(login.row));
      added += login.row == Row::kAdded;
      existing += login.row == Row::kExists;
      invalid += login.row == Row::kInvalid;
      failed += login.row == Row::kFailed || login.row == Row::kPending;
    }
    base::DictValue result;
    result.Set("added", added);
    result.Set("existing", existing);
    result.Set("invalid", invalid);
    result.Set("failed", failed);
    result.Set("results", std::move(results));
    reply_.Send(std::move(result));
  }
  logins_.clear();
  owner_->Done(this);
}

}
}

AC_PROFILE_CALL(ac_passwords_add_many,
                ardia::Sensitive{ardia::kMaxBatchArgsBytes}) {
  if (base::FeatureList::IsEnabled(
          password_manager::features::kSkipUndecryptablePasswords)) {
    return call.TakeReply().Error("partial password reads");
  }
  const base::ListValue* list = call.args().FindList("entries");
  if (!list || list->size() > ardia::kMaxBatchEntries) {
    return call.TakeReply().Error("bad arguments");
  }
  scoped_refptr<password_manager::PasswordStoreInterface> store =
      ProfilePasswordStoreFactory::GetForProfile(call.profile(),
                                                 ServiceAccessType::EXPLICIT_ACCESS);
  if (!store) {
    return call.TakeReply().Error("no password store");
  }
  std::vector<ardia::NewLogin> logins;
  logins.reserve(list->size());
  for (const base::Value& item : *list) {
    logins.push_back(ardia::Parse(item));
  }
  ardia::StateFor<ardia::AddsState>(call.profile())
      .Start(call.TakeReply(), std::move(store),
             AccountPasswordStoreFactory::GetForProfile(
                 call.profile(), ServiceAccessType::EXPLICIT_ACCESS),
             std::move(logins));
}
