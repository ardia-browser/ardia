#ifndef ARDIA_ENGINE_BRIDGE_H
#define ARDIA_ENGINE_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t ArdiaBridgeStatus;

enum {
  ARDIA_BRIDGE_OK = 0,
  ARDIA_BRIDGE_NOT_LOADED = 1,
  ARDIA_BRIDGE_NOT_STARTED = 2,
  ARDIA_BRIDGE_WRONG_THREAD = 3,
  ARDIA_BRIDGE_UNKNOWN_WINDOW = 4,
  ARDIA_BRIDGE_UNKNOWN_TAB = 5,
  ARDIA_BRIDGE_UNKNOWN_PROFILE = 6,
  ARDIA_BRIDGE_UNSUPPORTED = 7,
  ARDIA_BRIDGE_BAD_ARGUMENT = 8,
  ARDIA_BRIDGE_FAILED = 9,
  ARDIA_BRIDGE_ALREADY_RUNNING = 10,
  ARDIA_BRIDGE_NO_HOST = 11,
};

enum {
  ARDIA_COMPLETION_OK = 0,
  ARDIA_COMPLETION_ERROR = 1,
  ARDIA_COMPLETION_CANCELLED = 2,
};

#define ARDIA_BRIDGE_CREATE_WINDOW UINT64_MAX

typedef struct ArdiaBridgeHost {
  uint32_t size;
  void *context;
  void (*event)(void *context, const char *json);
  int32_t (*decide)(void *context, const char *json);
  uint64_t (*new_window)(void *context, uint64_t profile, const char *kind);
  char *(*answer)(void *context, const char *json);
  void (*release_answer)(void *context, char *answer);
  void (*complete)(void *context, uint64_t request, int32_t status, const char *json, const uint8_t *bytes, size_t length);
} ArdiaBridgeHost;

ArdiaBridgeStatus ardia_bridge_install(const ArdiaBridgeHost *host);
bool ardia_bridge_is_main_thread(void);
char *ardia_bridge_check_classes(const char *image);
bool ardia_bridge_engine_started(void);
ArdiaBridgeStatus ardia_bridge_release_confirms(bool close_anyway, uint64_t *released);

ArdiaBridgeStatus ardia_bridge_run(int32_t argc, const char *const *argv, int32_t *exit_code);
ArdiaBridgeStatus ardia_bridge_engine_call(const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_engine_async(const char *json, uint64_t request);

ArdiaBridgeStatus ardia_bridge_profile_call(uint64_t profile, const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_profile_async(uint64_t profile, const char *json, uint64_t request);

ArdiaBridgeStatus ardia_bridge_window_create(double x, double y, double width, double height, uint64_t *out_window);
ArdiaBridgeStatus ardia_bridge_window_call(uint64_t window, const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_window_object(uint64_t window, uint32_t which, void **out_object);

ArdiaBridgeStatus ardia_bridge_tab_call(uint64_t tab, const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_tab_async(uint64_t tab, const char *json, uint64_t request);
ArdiaBridgeStatus ardia_bridge_tab_view(uint64_t tab, uint32_t which, void **out_view);
ArdiaBridgeStatus ardia_bridge_tab_password(uint64_t tab, const char *action, const char *username, const uint8_t *password, size_t length);

ArdiaBridgeStatus ardia_bridge_page_view(void *view, uint32_t query, bool *out_answer);
ArdiaBridgeStatus ardia_bridge_set_scroll_observer(bool enabled);

void ardia_bridge_retain(void *object);
void ardia_bridge_release(void *object);
void ardia_bridge_free(char *text);

ArdiaBridgeStatus ardia_bridge_install_background_guard(void);
bool ardia_bridge_background_guard_installed(void);
ArdiaBridgeStatus ardia_bridge_window_levels(void *window, int64_t *asked, int64_t *actual);
ArdiaBridgeStatus ardia_bridge_menu_install(const char *json);
ArdiaBridgeStatus ardia_bridge_menu_build_describe(const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_alert(const char *json, void *window, uint64_t request);
ArdiaBridgeStatus ardia_bridge_alert_describe(const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_file_panel(const char *json, void *window, uint64_t request);
ArdiaBridgeStatus ardia_bridge_share(const char *json, void *view, double x, double y, double width, double height);
ArdiaBridgeStatus ardia_bridge_workspace(const char *json, char **out_json);
ArdiaBridgeStatus ardia_bridge_install_app_events(bool urls, bool reopen);
ArdiaBridgeStatus ardia_bridge_set_handoff(void *window, const char *url, const char *title);

typedef void (*ArdiaHostedVoidSuper)(void *thunk);
typedef bool (*ArdiaHostedBoolSuper)(void *thunk);

typedef struct ArdiaHostedWindowHooks {
  uint32_t size;
  void *context;
  void (*send_event)(void *context, void *window, void *event, ArdiaHostedVoidSuper call_super, void *thunk);
  void (*key_down)(void *context, void *window, void *event, ArdiaHostedVoidSuper call_super, void *thunk);
  bool (*make_first_responder)(void *context, void *window, void *responder, ArdiaHostedBoolSuper call_super, void *thunk);
  bool (*perform_key_equivalent)(void *context, void *window, void *event, ArdiaHostedBoolSuper call_super, void *thunk);
} ArdiaHostedWindowHooks;

ArdiaBridgeStatus ardia_bridge_style_browser_window(void *window);
ArdiaBridgeStatus ardia_bridge_hosted_hooks_install(const ArdiaHostedWindowHooks *hooks);
ArdiaBridgeStatus ardia_bridge_hosted_hooks_remove(uint64_t *restored);
bool ardia_bridge_hosted_hooks_installed(void);
ArdiaBridgeStatus ardia_bridge_hosted_window_attach(void *window);
ArdiaBridgeStatus ardia_bridge_hosted_window_attach_engine(uint64_t window);
ArdiaBridgeStatus ardia_bridge_hosted_window_detach(void *window);
bool ardia_bridge_hosted_window_attached(void *window);
uint64_t ardia_bridge_hosted_window_count(void);

#ifdef __cplusplus
}
#endif

#endif
