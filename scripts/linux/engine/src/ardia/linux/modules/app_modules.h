// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_APP_MODULES_H_
#define ARDIA_LINUX_MODULES_APP_MODULES_H_

namespace ardia_linux {

class DocumentStore;
class ModuleRegistry;

void RegisterAppModule(ModuleRegistry& registry);
void RegisterDocumentsModule(ModuleRegistry& registry);
void RegisterConfigModule(ModuleRegistry& registry);

DocumentStore& Documents();

}

#endif
