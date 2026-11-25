#ifndef ARDIA_LINUX_AC_LINUX_BANG_LIST_H_
#define ARDIA_LINUX_AC_LINUX_BANG_LIST_H_

#include "base/functional/callback.h"
#include "base/values.h"

namespace ardiacore {

void FetchLinuxBangList(const base::ListValue& args, base::OnceCallback<void(bool, base::Value)> done);

}

#endif
