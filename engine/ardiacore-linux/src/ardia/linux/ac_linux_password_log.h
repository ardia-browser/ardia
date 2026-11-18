#ifndef ARDIA_LINUX_AC_LINUX_PASSWORD_LOG_H_
#define ARDIA_LINUX_AC_LINUX_PASSWORD_LOG_H_

#include <string>

namespace ardia::linux_password {

void LogUnansweredCheck(const std::string& detail);

}

#endif
