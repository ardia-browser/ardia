#ifndef ARDIA_MAC_WEBUI_LAUNCH_ARGS_H_
#define ARDIA_MAC_WEBUI_LAUNCH_ARGS_H_

#include <stddef.h>
#include <stdio.h>
#include <string.h>

enum { kArdiaLaunchExtraArgs = 5, kArdiaLaunchPathLimit = 4096 };

#define ARDIA_LAUNCH_DEFAULT_DATA_SUFFIX "/Library/Application Support/Ardia WebUI Dev"

typedef struct {
  char data[kArdiaLaunchPathLimit];
  char user_data[kArdiaLaunchPathLimit + 32];
  char ardia_data[kArdiaLaunchPathLimit + 32];
} ArdiaLaunchStorage;

static inline int ArdiaSwitchEnd(int argc, const char* const argv[]) {
  for (int i = 1; i < argc; ++i) {
    if (argv[i] && strcmp(argv[i], "--") == 0) {
      return i;
    }
  }
  return argc;
}

static inline int ArdiaHasSwitch(int argc, const char* const argv[], const char* prefix) {
  const size_t length = strlen(prefix);
  const int end = ArdiaSwitchEnd(argc, argv);
  for (int i = 1; i < end; ++i) {
    if (argv[i] && strncmp(argv[i], prefix, length) == 0) {
      return 1;
    }
  }
  return 0;
}

static inline int ArdiaBackgroundValue(const char* value) {
  return value && (strcmp(value, "1") == 0 || strcmp(value, "true") == 0);
}

static inline int ArdiaUsablePath(const char* path) {
  return path && *path && strlen(path) < kArdiaLaunchPathLimit;
}

static inline const char* ArdiaResolveDataDir(const char* data, const char* home, ArdiaLaunchStorage* storage) {
  if (ArdiaUsablePath(data)) {
    return data;
  }
  if (!ArdiaUsablePath(home) || home[0] != '/') {
    return NULL;
  }
  const int written = snprintf(storage->data, sizeof(storage->data), "%s%s", home, ARDIA_LAUNCH_DEFAULT_DATA_SUFFIX);
  if (written <= 0 || (size_t)written >= sizeof(storage->data)) {
    return NULL;
  }
  return storage->data;
}

static inline int ArdiaBuildLaunchArgs(int argc,
                                       const char* const argv[],
                                       const char* data,
                                       const char* home,
                                       const char* background,
                                       ArdiaLaunchStorage* storage,
                                       const char** out) {
  int count = 0;
  const int end = ArdiaSwitchEnd(argc, argv);
  for (int i = 0; i < end; ++i) {
    out[count++] = argv[i];
  }
  if (ArdiaHasSwitch(argc, argv, "--type=")) {
    for (int i = end; i < argc; ++i) {
      out[count++] = argv[i];
    }
    return count;
  }
  if (!ArdiaHasSwitch(argc, argv, "--user-data-dir=")) {
    const char* resolved = ArdiaResolveDataDir(data, home, storage);
    if (resolved) {
      snprintf(storage->user_data, sizeof(storage->user_data), "--user-data-dir=%s/Chromium", resolved);
      snprintf(storage->ardia_data, sizeof(storage->ardia_data), "--ardia-data-dir=%s", resolved);
      out[count++] = storage->user_data;
      out[count++] = storage->ardia_data;
      out[count++] = "--use-mock-keychain";
    }
  }
  if (!ArdiaHasSwitch(argc, argv, "--ardia-shell=")) {
    out[count++] = "--ardia-shell=webui";
  }
  if (ArdiaBackgroundValue(background) && !ArdiaHasSwitch(argc, argv, "--ardia-background")) {
    out[count++] = "--ardia-background";
  }
  for (int i = end; i < argc; ++i) {
    out[count++] = argv[i];
  }
  return count;
}

#endif
