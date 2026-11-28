// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/feature_list.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ref.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/password_manager/factories/account_password_store_factory.h"
#include "chrome/browser/password_manager/factories/profile_password_store_factory.h"
#include "components/keyed_service/core/service_access_type.h"
#include "components/password_manager/core/browser/features/password_features.h"
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

constexpr size_t kMaxReplaceArgsBytes = 256 * 1024;
constexpr base::TimeDelta kReplaceTimeout = base::Seconds(30);

struct Login {
  std::string realm;
  GURL url;
  std::u16string username;
};

std::optional<Login> LoginAt(const std::string& origin, const std::string& username) {
  const GURL url(origin);
  if (!url.is_valid()) {
    return std::nullopt;
  }
  std::string realm = password_manager_util::GetSignonRealm(url);
  if (realm != origin + "/") {
    return std::nullopt;
  }
  return Login{std::move(realm), url, base::UTF8ToUTF16(username)};
}

bool SameLogin(const StoredCredential& credential, const Login& login) {
  return credential.signon_realm == login.realm && credential.username_value == login.username;
}

bool Replaceable(const StoredCredential& credential, const Login& login) {
  return SameLogin(credential, login) && !credential.blocked_by_user &&
         !credential.federation_origin.IsValid();
}

bool HoldsKeyOf(const StoredCredential& credential, const Login& login) {
  return SameLogin(credential, login) && credential.url == login.url &&
         credential.username_element.empty() && credential.password_element.empty();
}

struct Written {
  bool account;
  GURL url;
  std::string signon_realm;
  std::u16string username_element;
  std::u16string username_value;
  std::u16string password_element;

  static Written Of(const StoredCredential& credential, bool account) {
    return Written{account,
                   credential.url,
                   credential.signon_realm,
                   credential.username_element,
                   credential.username_value,
                   credential.password_element};
  }

  bool IsFormOf(const StoredCredential& credential) const {
    return credential.url == url && credential.signon_realm == signon_realm &&
           credential.username_element == username_element && credential.username_value == username_value &&
           credential.password_element == password_element;
  }
};

void Forget(Credentials& credentials) {
  for (StoredCredential& credential : credentials) {
    credential.password_value.clear();
  }
}

password_manager::PasswordString StoredPassword(const std::u16string& password) {
  std::u16string copy = password;
  password_manager::PasswordString stored(std::move(copy));
  Cleanse(copy);
  return stored;
}

class ReplacesState;

class Replace : public password_manager::PasswordStoreConsumer {
 public:
  Replace(ReplacesState& owner,
          Reply reply,
          scoped_refptr<PasswordStoreInterface> profile_store,
          scoped_refptr<PasswordStoreInterface> account_store,
          Login login,
          const std::u16string& password,
          std::optional<std::u16string> expected)
      : owner_(owner),
        reply_(std::move(reply)),
        profile_store_(std::move(profile_store)),
        account_store_(std::move(account_store)),
        login_(std::move(login)),
        password_(password),
        expected_(std::move(expected)) {}

  ~Replace() override {
    Cleanse(password_);
    ForgetExpected();
    ForgetRead();
    if (!settled_) {
      reply_.Error("closed");
    }
  }

  void Start() {
    timeout_.Start(FROM_HERE, kReplaceTimeout,
                   base::BindOnce(&Replace::Finish, weak_factory_.GetWeakPtr(),
                                  std::string_view("The password store didn't answer")));
    Read(Step::kWrite);
  }

  void OnGetPasswordStoreResultsOrErrorFrom(PasswordStoreInterface* from,
                                            CredentialsOrError result) override {
    if (!result.has_value()) {
      return Finish("unreadable");
    }
    (from == profile_store_.get() ? profile_ : account_) = std::move(*result);
    if (!profile_ || !account_) {
      return;
    }
    if (step_ == Step::kWrite) {
      Write();
    } else {
      Verify();
    }
    ForgetRead();
  }

 private:
  enum class Step { kWrite, kVerify };

  void Read(Step step) {
    step_ = step;
    ForgetRead();
    if (!account_store_) {
      account_ = Credentials();
    }
    profile_store_->GetAllLogins(weak_factory_.GetWeakPtr());
    if (account_store_) {
      account_store_->GetAllLogins(weak_factory_.GetWeakPtr());
    }
  }

  void ForgetRead() {
    for (std::optional<Credentials>* read : {&profile_, &account_}) {
      if (*read) {
        Forget(**read);
      }
      read->reset();
    }
  }

  void ForgetExpected() {
    if (expected_) {
      Cleanse(*expected_);
    }
  }

  bool Expected(const StoredCredential& credential) const {
    return Replaceable(credential, login_) && (!expected_ || credential.password_value == *expected_);
  }

  bool Changes(Credentials& credentials, Credentials& changes, bool account) {
    bool found = false;
    for (StoredCredential& credential : credentials) {
      if (!Expected(credential)) {
        continue;
      }
      found = true;
      if (credential.password_value == password_) {
        continue;
      }
      credential.password_value = StoredPassword(password_);
      credential.date_password_modified = base::Time::Now();
      credential.password_issues.clear();
      written_.push_back(Written::Of(credential, account));
      changes.push_back(std::move(credential));
    }
    return found;
  }

  base::OnceClosure Wrote() {
    return base::BindOnce(&Replace::OneWritten, weak_factory_.GetWeakPtr());
  }

  void OneWritten() {
    if (--writes_ == 0) {
      Read(Step::kVerify);
    }
  }

  void Write() {
    Credentials profile_changes;
    Credentials account_changes;
    const bool in_profile = Changes(*profile_, profile_changes, false);
    const bool in_account = Changes(*account_, account_changes, true);
    if (in_profile || in_account) {
      writes_ = !profile_changes.empty() + !account_changes.empty();
      if (writes_ == 0) {
        return Finish({});
      }
      if (!profile_changes.empty()) {
        profile_store_->UpdateLogins(std::move(profile_changes), Wrote());
      }
      if (!account_changes.empty()) {
        account_store_->UpdateLogins(std::move(account_changes), Wrote());
      }
      return;
    }
    if (expected_) {
      return Finish("The login changed while it was being saved");
    }
    if (std::ranges::any_of(*profile_, [this](const StoredCredential& credential) {
          return HoldsKeyOf(credential, login_);
        })) {
      return Finish("A blocked or federated entry holds this login");
    }
    writes_ = 1;
    StoredCredential added = Added();
    written_.push_back(Written::Of(added, false));
    profile_store_->AddLogin(std::move(added), Wrote());
  }

  StoredCredential Added() const {
    StoredCredential added;
    added.scheme = PasswordForm::Scheme::kHtml;
    added.url = login_.url;
    added.signon_realm = login_.realm;
    added.username_value = login_.username;
    added.password_value = StoredPassword(password_);
    added.type = PasswordForm::Type::kManuallyAdded;
    added.date_created = base::Time::Now();
    added.date_password_modified = added.date_created;
    added.in_store = PasswordForm::Store::kProfileStore;
    return added;
  }

  void Verify() {
    const bool landed = std::ranges::all_of(written_, [this](const Written& written) {
      return std::ranges::any_of(written.account ? *account_ : *profile_, [&](const StoredCredential& credential) {
        return written.IsFormOf(credential) && credential.password_value == password_;
      });
    });
    bool stale = false;
    for (const Credentials* read : {&*profile_, &*account_}) {
      stale = stale || std::ranges::any_of(*read, [this](const StoredCredential& credential) {
                return Expected(credential) && credential.password_value != password_;
              });
    }
    Finish(landed && !stale ? std::string_view() : std::string_view("The login changed while it was being saved"));
  }

  void Finish(std::string_view error);

  const raw_ref<ReplacesState> owner_;
  Reply reply_;
  bool settled_ = false;
  scoped_refptr<PasswordStoreInterface> profile_store_;
  scoped_refptr<PasswordStoreInterface> account_store_;
  const Login login_;
  std::u16string password_;
  std::optional<std::u16string> expected_;
  std::optional<Credentials> profile_;
  std::optional<Credentials> account_;
  std::vector<Written> written_;
  int writes_ = 0;
  Step step_ = Step::kWrite;
  base::OneShotTimer timeout_;
  base::WeakPtrFactory<Replace> weak_factory_{this};
};

class ReplacesState : public ProfileState {
 public:
  explicit ReplacesState(Profile* profile) : ProfileState(profile) {}

  void Start(Reply reply,
             scoped_refptr<PasswordStoreInterface> profile_store,
             scoped_refptr<PasswordStoreInterface> account_store,
             Login login,
             const std::u16string& password,
             std::optional<std::u16string> expected) {
    replaces_.push_back(std::make_unique<Replace>(*this, std::move(reply), std::move(profile_store),
                                                  std::move(account_store), std::move(login), password,
                                                  std::move(expected)));
    replaces_.back()->Start();
  }

  void Done(Replace* replace) {
    auto found = std::ranges::find_if(replaces_, [replace](const auto& owned) { return owned.get() == replace; });
    if (found == replaces_.end()) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, std::move(*found));
    replaces_.erase(found);
  }

 private:
  void Release() override { replaces_.clear(); }

  std::vector<std::unique_ptr<Replace>> replaces_;
};

void Replace::Finish(std::string_view error) {
  if (settled_) {
    return;
  }
  settled_ = true;
  weak_factory_.InvalidateWeakPtrs();
  timeout_.Stop();
  Cleanse(password_);
  ForgetExpected();
  if (error.empty()) {
    reply_.Ok();
  } else {
    reply_.Error(error);
  }
  owner_->Done(this);
}

}
}

AC_PROFILE_CALL(ac_passwords_replace, ardia::Sensitive{ardia::kMaxReplaceArgsBytes}) {
  if (base::FeatureList::IsEnabled(password_manager::features::kSkipUndecryptablePasswords)) {
    return call.TakeReply().Error("partial password reads");
  }
  std::optional<ardia::Secret> password = call.SecretAt("password");
  std::optional<ardia::Secret> expected = call.SecretAt("expected");
  if (!password || !expected) {
    return call.TakeReply().Error("bad arguments");
  }
  std::optional<ardia::Login> login = ardia::LoginAt(call.String("origin"), call.String("username"));
  if (!login || password->value().empty() || (expected->present() && expected->value().empty())) {
    return call.TakeReply().Error("origin and password required");
  }
  scoped_refptr<password_manager::PasswordStoreInterface> profile_store =
      ProfilePasswordStoreFactory::GetForProfile(call.profile(), ServiceAccessType::EXPLICIT_ACCESS);
  if (!profile_store) {
    return call.TakeReply().Error("no password store");
  }
  scoped_refptr<password_manager::PasswordStoreInterface> account_store =
      AccountPasswordStoreFactory::GetForProfile(call.profile(), ServiceAccessType::EXPLICIT_ACCESS);
  std::u16string password16 = base::UTF8ToUTF16(password->value());
  std::optional<std::u16string> expected16;
  if (expected->present()) {
    expected16 = base::UTF8ToUTF16(expected->value());
  }
  ardia::StateFor<ardia::ReplacesState>(call.profile())
      .Start(call.TakeReply(), std::move(profile_store), std::move(account_store), std::move(*login), password16,
             expected16);
  ardia::Cleanse(password16);
  if (expected16) {
    ardia::Cleanse(*expected16);
  }
}
