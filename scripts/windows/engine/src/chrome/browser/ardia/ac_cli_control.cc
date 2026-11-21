#include <string>

#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"
#include "chrome/browser/ardia/ac_engine.h"

namespace ardia {

std::string TokenServerEndpoint() {
  return std::string();
}

}

AC_ARGS_CALL(ac_cli_control) {
  call.TakeReply().Error("the ardia command is not on Windows yet");
}

AC_ARGS_CALL(ac_cli_owns_tab) {
  call.TakeReply().Error("the ardia command is not on Windows yet");
}
