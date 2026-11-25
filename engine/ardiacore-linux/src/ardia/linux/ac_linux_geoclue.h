#ifndef ARDIA_LINUX_AC_LINUX_GEOCLUE_H_
#define ARDIA_LINUX_AC_LINUX_GEOCLUE_H_

#include <memory>
#include <string>

namespace device {
class LocationProvider;
}

namespace ardia {

std::unique_ptr<device::LocationProvider> CreateLinuxLocationProvider();
void InstallLinuxLocationProvider();
std::string LinuxLocationPermission();

}

#endif
