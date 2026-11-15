// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_LOCATION_H_
#define ARDIA_LINUX_MODULES_LOCATION_H_

#include <memory>

namespace device {
class LocationProvider;
}

namespace ardia_linux {

class ModuleRegistry;

std::unique_ptr<device::LocationProvider> CreateGeoClueLocationProvider();

void RegisterLocationModule(ModuleRegistry& registry);

}

#endif
