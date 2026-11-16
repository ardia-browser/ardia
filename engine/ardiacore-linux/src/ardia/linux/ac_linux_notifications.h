#ifndef ARDIA_LINUX_AC_LINUX_NOTIFICATIONS_H_
#define ARDIA_LINUX_AC_LINUX_NOTIFICATIONS_H_

#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

class Profile;

namespace ardiacore {

using LinuxNotificationSink = base::RepeatingCallback<void(int owner, bool clicked, base::Value response)>;

void InitLinuxNotifications(LinuxNotificationSink sink);
bool LinuxNotificationsInvokes(std::string_view method);
void LinuxNotificationsInvoke(std::string_view method, const base::ListValue& args, Profile* profile, int owner,
                              base::OnceCallback<void(bool, base::Value)> done);

}

#endif
