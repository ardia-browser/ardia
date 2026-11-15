#ifndef ARDIA_LINUX_AC_LINUX_UPDATES_H_
#define ARDIA_LINUX_AC_LINUX_UPDATES_H_

#include <string>

#include "ardia/linux/ac_linux_updates_policy.h"
#include "base/functional/callback.h"

namespace ardia::linux_updates {

using FetchReply = base::OnceCallback<void(int status, std::string body)>;

void Fetch(linux_updates_policy::Source source, FetchReply reply);

}

#endif
