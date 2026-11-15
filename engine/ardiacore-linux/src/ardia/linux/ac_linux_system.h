#ifndef ARDIA_LINUX_AC_LINUX_SYSTEM_H_
#define ARDIA_LINUX_AC_LINUX_SYSTEM_H_

#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

namespace ardiacore {

bool LinuxSystemInvokes(std::string_view method);
void LinuxSystemInvoke(std::string_view method, const base::ListValue& args,
                       base::OnceCallback<void(bool, base::Value)> done);

}

#endif
