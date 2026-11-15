// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_APP_MODULES_H_
#define ARDIA_LINUX_MODULES_APP_MODULES_H_

#include "base/functional/callback.h"
#include "base/values.h"

namespace ardia_linux {

class DocumentStore;
class ModuleRegistry;

void RegisterAppModule(ModuleRegistry& registry);
void RegisterDocumentsModule(ModuleRegistry& registry);
void RegisterConfigModule(ModuleRegistry& registry);
void RegisterDialogsModule(ModuleRegistry& registry);
void RegisterFocusModule(ModuleRegistry& registry);
void RegisterMenusModule(ModuleRegistry& registry);
void RegisterShellModule(ModuleRegistry& registry);
void RegisterSystemModule(ModuleRegistry& registry);
void RegisterLaunchLinksModule(ModuleRegistry& registry);
void RegisterKeychainModule(ModuleRegistry& registry);
void RegisterNotificationsModule(ModuleRegistry& registry);

void ConfirmWithUser(const base::DictValue& options,
                     base::OnceCallback<void(bool confirmed, bool suppressed)>
                         done);

DocumentStore& Documents();

}

#endif
