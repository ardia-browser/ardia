// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_TELEMETRY_FILES_H_
#define ARDIA_LINUX_MODULES_TELEMETRY_FILES_H_

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/time/time.h"

namespace ardia_linux {

bool IsTelemetryDay(std::string_view day);

std::string UtcDay(base::Time at);

struct TelemetryPruned {
  int64_t bytes = 0;
  int64_t lines = 0;
  int files = 0;
  int64_t dropped_lines = 0;
};

class TelemetryFiles {
 public:
  explicit TelemetryFiles(base::FilePath folder);

  const base::FilePath& folder() const { return folder_; }

  void Append(std::string_view day, const std::vector<std::string>& lines);
  TelemetryPruned Prune(base::Time now, int64_t max_bytes, base::TimeDelta keep);
  std::string Collect(base::Time since, int64_t* lines) const;
  void Clear();

 private:
  struct DayFile {
    base::FilePath path;
    std::string day;
    int64_t bytes;
  };

  std::vector<DayFile> Files() const;

  const base::FilePath folder_;
};

}

#endif
