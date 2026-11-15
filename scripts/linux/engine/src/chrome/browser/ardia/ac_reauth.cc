// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_reauth.h"

#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/ardia/ac_engine.h"

namespace ardia {

void Reauth(Profile* profile,
            device_reauth::DeviceAuthSource source,
            const std::u16string& purpose,
            base::TimeDelta validity,
            base::OnceCallback<void(bool)> done) {
  const bool hidden_test = ardiacore::BackgroundInstance();
  const bool granted =
      hidden_test && ardiacore::TestValue("reauth") == "granted";
  if (hidden_test) {
    LOG(WARNING) << "[ardia] OS reauth (" << purpose
                 << ") in a hidden test instance, no prompt: "
                 << (granted ? "granted" : "denied");
  } else {
    LOG(WARNING) << "[ardia] OS reauth refused: the owner check isn't on "
                    "Linux yet";
  }
  Emit("reauth.requested", profile,
       base::DictValue().Set("purpose", purpose).Set("granted", granted));
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(done), granted));
}

}
