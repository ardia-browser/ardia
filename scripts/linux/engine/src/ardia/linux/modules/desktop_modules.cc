// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/import_module.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/edge_pointer.h"
#include "ardia/linux/modules/file_drop.h"
#include "ardia/linux/modules/owner_check.h"
#include "ardia/linux/modules/screen_lock.h"
#include "ardia/linux/sync/sync_module.h"
#include "ardia/linux/ui_host/modules.h"

namespace ardia_linux {

void RegisterDesktopModules(ModuleRegistry& registry) {
  RegisterSystemSignalsModule(registry);
  RegisterOwnerCheck(registry);
  RegisterEdgePointerModule(registry);
  RegisterFileDropModule(registry);
  RegisterSyncModule(registry);
  RegisterImportHostModule(registry);
}

}
