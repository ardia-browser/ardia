// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/app_modules.h"

#include "ardia/linux/ui_host/modules.h"

namespace ardia_linux {

void RegisterAppModules(ModuleRegistry& registry) {
  RegisterDocumentsModule(registry);
  RegisterConfigModule(registry);
  RegisterAppModule(registry);
  RegisterMenusModule(registry);
  RegisterDialogsModule(registry);
  RegisterFocusModule(registry);
  RegisterShellModule(registry);
  RegisterSystemModule(registry);
  RegisterLaunchLinksModule(registry);
  RegisterKeychainModule(registry);
  RegisterNotificationsModule(registry);
  RegisterTelemetryLocalModule(registry);
  RegisterDevModule(registry);
  RegisterDesktopModules(registry);
}

}
