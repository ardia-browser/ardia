// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_TEST_GATE_H_
#define ARDIA_LINUX_TEST_GATE_H_

#include <string>

#include "base/files/file_path.h"

namespace ardia_linux {

inline constexpr char kTestInstanceSwitch[] = "ardia-test-instance";
inline constexpr char kTestBuildMarker[] = "ardia.test-build";

std::string TestGateRefusal(const base::FilePath& data_dir);

std::string HoldScratchFolders(const base::FilePath& data_dir);

std::string ScratchProfileRefusal(const base::FilePath& chromium_root);

}

#endif
