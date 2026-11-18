#include "ardia/linux/ac_linux_password_log.h"

#include "base/logging.h"

namespace ardia::linux_password {

void LogUnansweredCheck(const std::string& detail) {
  LOG(WARNING) << "[ardia] the login password was not checked: helper " << detail;
}

}
