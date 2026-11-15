// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_TEST_ANSWERS_H_
#define ARDIA_LINUX_MODULES_TEST_ANSWERS_H_

#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"

namespace ardia_linux {

void TakeFileChooserPicks(
    base::OnceCallback<void(std::vector<std::string>)> done);

void DumpAndTakePick(std::string file_name,
                     std::string dumped,
                     base::OnceCallback<void(std::optional<std::string>)> done);

}

#endif
