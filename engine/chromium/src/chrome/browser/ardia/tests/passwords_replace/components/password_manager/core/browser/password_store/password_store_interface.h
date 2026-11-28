#pragma once
#include <string>
#include <vector>
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "components/password_manager/core/browser/password_store/password_store_consumer.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
namespace password_manager {
class PasswordStoreInterface {
 public:
  virtual ~PasswordStoreInterface() = default;
  virtual void AddLogin(StoredCredential form, base::OnceClosure completion) = 0;
  virtual void UpdateLogins(std::vector<StoredCredential> forms, base::OnceClosure completion) = 0;
  virtual void UpdateLoginsIfPasswordIs(std::vector<StoredCredential> forms, std::u16string expected,
                                        base::OnceCallback<void(bool)> completion) = 0;
  virtual void AddLoginIfAbsent(StoredCredential form, base::OnceCallback<void(bool)> completion) = 0;
  virtual void GetAllLogins(base::WeakPtr<PasswordStoreConsumer> consumer) = 0;
};
}
