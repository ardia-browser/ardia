#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ARDIA_ENGINE_API_VERSION 1

#define ARDIA_APP_LAUNCH_TURNED_AWAY 0
#define ARDIA_APP_LAUNCH_KEPT 1
#define ARDIA_APP_LAUNCH_KEPT_BY_CANCELLING_QUIT 2
#define ARDIA_APP_LAUNCH_LEFT_FOR_UPDATE 3

typedef void (*ArdiaEngineReply)(void *context, const char *json);
typedef void (*ArdiaEngineEventSink)(void *context, const char *topic, const char *json);

typedef struct ArdiaEngineApi {
  uint32_t version;
  uint32_t size;
  void (*setEventSink)(ArdiaEngineEventSink sink, void *context);
  void (*hostCall)(const char *verb, const char *argsJson, uint64_t windowHandle, ArdiaEngineReply reply, void *context);
  void (*engineCall)(const char *name, const char *profileDir, const char *argsJson, ArdiaEngineReply reply, void *context);
  const char *(*testGateRefusal)(void);
} ArdiaEngineApi;

typedef int (*ArdiaAppStartFunction)(const ArdiaEngineApi *engine);
typedef int (*ArdiaAppPreTranslateFunction)(const void *message);
typedef void (*ArdiaAppStopFunction)(void);
typedef int (*ArdiaAppRunFunction)(void);
typedef const wchar_t *(*ArdiaAppStartFailureFunction)(void);
typedef int (*ArdiaAppLaunchArrivingFunction)(void);
typedef void (*ArdiaAppLaunchDeliveredFunction)(void);
typedef void (*ArdiaAppAfterLaunchArrivingFunction)(void);

#ifdef __cplusplus
}
#endif
