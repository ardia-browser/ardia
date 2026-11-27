#include "ardia_core.h"
#include "ardia_update.h"

#include <cstdio>
#include <string>

namespace {

int Fail(const char* what) {
  std::fprintf(stderr, "ardia_update C++ smoke failed: %s\n", what);
  return 1;
}

int Compare(const std::string& left, const std::string& right, int32_t* order) {
  return ardia_update_compare_versions(reinterpret_cast<const uint8_t*>(left.data()), left.size(),
                                       reinterpret_cast<const uint8_t*>(right.data()), right.size(), order);
}

}

int main() {
  static_assert(sizeof(ardia_update_package) == sizeof(uint64_t) + ARDIA_UPDATE_SHA256_BYTES, "package layout");
  static_assert(ARDIA_UPDATE_STATUS_OK == 0 && ARDIA_STATUS_OK == 0, "both headers in one translation unit");
  const std::string ascending[] = {"0.2.47", "0.2.48-nightly.0", "0.2.48-nightly.10", "0.2.48", "0.10.0"};
  int status = 0;
  for (size_t i = 0; i + 1 < sizeof ascending / sizeof ascending[0]; ++i) {
    int32_t order = 9;
    if (Compare(ascending[i], ascending[i + 1], &order) != ARDIA_UPDATE_STATUS_OK || order != -1) status = Fail(ascending[i].c_str());
  }
  int32_t order = 9;
  if (Compare("0.2.48-beta.1", "0.2.48", &order) != ARDIA_UPDATE_STATUS_VERSION || order != 0) status = Fail("beta refused");
  ardia_update_package package{7, {7}};
  const std::string manifest = "ardia-linux-update 1\nversion 0.2.48\n";
  const uint8_t key[ARDIA_UPDATE_PUBLIC_KEY_BYTES] = {};
  if (ardia_update_verify_linux(reinterpret_cast<const uint8_t*>(manifest.data()), manifest.size(), nullptr, 0, key,
                                sizeof key, reinterpret_cast<const uint8_t*>("0.2.48"), 6,
                                reinterpret_cast<const uint8_t*>("0.2.47"), 6, ARDIA_UPDATE_KIND_DEB,
                                &package) != ARDIA_UPDATE_STATUS_SIGNATURE ||
      package.size != 0)
    status = Fail("unsigned manifest");
  ardia_update_windows_package win_package{};
  const std::string win_prefix = "https://github.com/ardia-browser/ardia/releases/download/";
  if (ardia_update_verify_windows(reinterpret_cast<const uint8_t*>("{}"), 2, nullptr, 0, key, sizeof key,
                                  reinterpret_cast<const uint8_t*>(win_prefix.data()), win_prefix.size(),
                                  ARDIA_UPDATE_WINDOWS_CPU_X64, 1, &win_package) != ARDIA_UPDATE_STATUS_SIGNATURE ||
      win_package.build != 0)
    status = Fail("unsigned windows manifest");
  if (status == 0) std::printf("ardia_update C++ smoke passed\n");
  return status;
}
