// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_reauth.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/ardia/ac_owner_check.h"
#include "chrome/browser/profiles/profile.h"

namespace ardia {

namespace {

OwnerCheck g_owner_check = nullptr;

OwnerCheckPurpose PurposeOf(device_reauth::DeviceAuthSource source,
                            const std::u16string& prompt) {
  if (source == device_reauth::DeviceAuthSource::kAutofill) {
    return OwnerCheckPurpose::kPaymentMethods;
  }
  const std::string text = base::ToLowerASCII(base::UTF16ToUTF8(prompt));
  if (text.find("export") != std::string::npos) {
    return OwnerCheckPurpose::kExportPasswords;
  }
  if (text.find("edit") != std::string::npos ||
      text.find("change") != std::string::npos) {
    return OwnerCheckPurpose::kEditPasswords;
  }
  return OwnerCheckPurpose::kShowPasswords;
}

void Answered(base::WeakPtr<Profile> profile,
              std::u16string purpose,
              base::OnceCallback<void(bool)> done,
              bool granted) {
  if (profile) {
    Emit("reauth.requested", profile.get(),
         base::DictValue().Set("purpose", purpose).Set("granted", granted));
  }
  std::move(done).Run(granted);
}

}

void SetOwnerCheck(OwnerCheck check) {
  g_owner_check = check;
}

void Reauth(Profile* profile,
            device_reauth::DeviceAuthSource source,
            const std::u16string& purpose,
            base::TimeDelta validity,
            base::OnceCallback<void(bool)> done) {
  if (!g_owner_check) {
    LOG(WARNING) << "[ardia] OS reauth refused: no owner check";
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&Answered, profile->GetWeakPtr(), purpose,
                                  std::move(done), false));
    return;
  }
  g_owner_check(PurposeOf(source, purpose),
                base::BindOnce(&Answered, profile->GetWeakPtr(), purpose,
                               std::move(done)));
}

}
