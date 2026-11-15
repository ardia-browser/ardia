// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/log.h"

#include <fcntl.h>
#include <unistd.h>

#include <string>

#include "ardia/core/ac_launch_switches.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/nix/xdg_util.h"
#include "base/environment.h"
#include "base/strings/strcat.h"
#include "base/time/time.h"
#include "base/strings/stringprintf.h"

namespace ardia_linux {

namespace {

std::string Stamp() {
  base::Time::Exploded now;
  base::Time::Now().UTCExplode(&now);
  return base::StringPrintf("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", now.year,
                            now.month, now.day_of_month, now.hour, now.minute,
                            now.second, now.millisecond);
}

void Append(const base::FilePath& path, const std::string& line) {
  const int fd = HANDLE_EINTR(
      open(path.value().c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC,
           0600));
  if (fd < 0) {
    return;
  }
  base::WriteFileDescriptor(fd, line);
  IGNORE_EINTR(close(fd));
}

}

base::FilePath DataDirectory() {
  const base::FilePath from_switch =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
          ardiacore::kDataDirSwitch);
  if (!from_switch.empty()) {
    return from_switch;
  }
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  return base::nix::GetXDGDirectory(env.get(), "XDG_DATA_HOME",
                                    ".local/share")
      .Append("ardia");
}

void Note(std::string_view area, std::string_view message) {
  LOG(WARNING) << "[ardia " << area << "] " << message;
  const std::string line = base::StrCat(
      {Stamp(), " ", area, " ", message, "\n"});
  Append(DataDirectory().Append("launch.log"), line);
}

void NoteActivation(std::string_view message) {
  Note("activation", message);
  Append(DataDirectory().Append("activation.log"),
         base::StrCat({Stamp(), " ", message,
                       "\n"}));
}

}
