#include <dlfcn.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "launch_args.h"

static const char* ArdiaHomeDirectory(void) {
  const char* home = getenv("HOME");
  if (home && *home) {
    return home;
  }
  const struct passwd* account = getpwuid(getuid());
  return account ? account->pw_dir : NULL;
}

int main(int argc, const char* argv[]) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    return 1;
  }
  char framework[PATH_MAX];
  snprintf(framework, sizeof(framework),
           "%s/../Frameworks/Chromium Framework.framework/Chromium Framework",
           dirname(executable));
  void* library = dlopen(framework, RTLD_LAZY | RTLD_LOCAL | RTLD_FIRST);
  if (!library) {
    fprintf(stderr, "Ardia WebUI Dev: %s\n", dlerror());
    return 1;
  }
  int (*chrome_main)(int, const char**) =
      (int (*)(int, const char**))dlsym(library, "ChromeMain");
  if (!chrome_main) {
    fprintf(stderr, "Ardia WebUI Dev: no ChromeMain in %s\n", framework);
    return 1;
  }
  const char** args = calloc((size_t)argc + kArdiaLaunchExtraArgs + 1, sizeof(char*));
  static ArdiaLaunchStorage storage;
  if (!args) {
    return 1;
  }
  const int count = ArdiaBuildLaunchArgs(argc, argv, getenv("ARDIA_DATA_DIR"), ArdiaHomeDirectory(),
                                         getenv("ARDIA_BACKGROUND"), &storage, args);
  return chrome_main(count, args);
}
