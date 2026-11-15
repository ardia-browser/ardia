// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/owner_check.h"

#include <pwd.h>
#include <unistd.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/owner_check_core.h"
#include "ardia/linux/modules/owner_prompt.h"
#include "ardia/linux/modules/screen_lock.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/ardia/ac_owner_check.h"

namespace ardia_linux {

namespace {

std::string CurrentUserName() {
  struct passwd entry;
  struct passwd* found = nullptr;
  char buffer[4096];
  if (getpwuid_r(getuid(), &entry, buffer, sizeof(buffer), &found) != 0 ||
      !found || !found->pw_name) {
    return std::string();
  }
  return found->pw_name;
}

std::optional<base::FilePath> FindPasswordHelper(std::string test_helper) {
  if (!test_helper.empty()) {
    base::FilePath path(test_helper);
    return base::PathExists(path) ? std::optional(path) : std::nullopt;
  }
  for (const base::FilePath& candidate : PasswordHelperCandidates()) {
    if (std::optional<base::FilePath> trusted = TrustedPasswordHelper(
            candidate, base::BindRepeating(&StatHelperFileOnDisk))) {
      return trusted;
    }
  }
  return std::nullopt;
}

HelperVerdict CheckOnPool(base::FilePath helper, SecretBytes password) {
  std::string user = CurrentUserName();
  if (user.empty()) {
    return HelperVerdict::kFailed;
  }
  return RunPasswordHelper(helper, user, std::move(password));
}

OwnerCheck& Check() {
  static base::NoDestructor<OwnerCheck> check([] {
    const LaunchConfig& config = CurrentLaunchConfig();
    OwnerCheck::Delegate delegate;
    if (config.test_instance && config.test.contains("reauth")) {
      delegate.test_answer = config.TestValue("reauth");
    }
    std::string test_helper =
        config.test_instance ? config.TestValue("passwordHelper")
                             : std::string();
    delegate.find_helper = base::BindRepeating(
        [](std::string test_helper, OwnerCheck::HelperFound found) {
          base::ThreadPool::PostTaskAndReplyWithResult(
              FROM_HERE,
              {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
              base::BindOnce(&FindPasswordHelper, test_helper),
              std::move(found));
        },
        std::move(test_helper));
    delegate.check_password = base::BindRepeating(
        [](const base::FilePath& helper, SecretBytes password,
           base::OnceCallback<void(HelperVerdict)> checked) {
          base::ThreadPool::PostTaskAndReplyWithResult(
              FROM_HERE,
              {base::MayBlock(), base::WithBaseSyncPrimitives(),
               base::TaskPriority::USER_BLOCKING,
               base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN},
              base::BindOnce(&CheckOnPool, helper, std::move(password)),
              std::move(checked));
        });
    delegate.count = base::BindRepeating(&CountLinux);
    delegate.log = base::BindRepeating(
        [](std::string_view message) { Note("owner", message); });
    return delegate;
  }(), CreateWindowOwnerPromptUi());
  return *check;
}

std::string ReasonForPurpose(ardia::OwnerCheckPurpose purpose) {
  switch (purpose) {
    case ardia::OwnerCheckPurpose::kShowPasswords:
      return "show your saved passwords";
    case ardia::OwnerCheckPurpose::kEditPasswords:
      return "change your saved passwords";
    case ardia::OwnerCheckPurpose::kExportPasswords:
      return "export your saved passwords";
    case ardia::OwnerCheckPurpose::kPaymentMethods:
      return "show your saved payment methods";
  }
  return "show your saved passwords";
}

void ChromeAsksForOwner(ardia::OwnerCheckPurpose purpose,
                        base::OnceCallback<void(bool)> done) {
  ConfirmDeviceOwner(ReasonForPurpose(purpose), std::move(done));
}

}

void ConfirmDeviceOwner(const std::string& reason,
                        base::OnceCallback<void(bool)> done) {
  Check().Confirm(reason, std::move(done));
}

int OwnerPresence() {
  return Check().presence();
}

bool OwnerStillPresent(int presence) {
  return Check().StillPresent(presence);
}

void WhenOwnerAway(base::RepeatingClosure listener) {
  Check().AddAwayListener(std::move(listener));
}

void RegisterOwnerCheck(ModuleRegistry& registry) {
  WhenOwnerLeaves(base::BindRepeating([] { Check().OwnerWentAway(); }));
  ardia::SetOwnerCheck(&ChromeAsksForOwner);
}

}
