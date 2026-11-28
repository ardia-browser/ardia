#ifndef ARDIA_CORE_AC_FEATURE_SWITCHES_H_
#define ARDIA_CORE_AC_FEATURE_SWITCHES_H_

#include <string_view>

namespace base {
class CommandLine;
}

namespace ardiacore {

void MergeFeatures(base::CommandLine* command_line, const char* list, std::string_view features);

bool CommandLineDecidesFeature(const base::CommandLine& command_line, std::string_view feature);

void ReportDanglingUnretainedWithoutCrashing(base::CommandLine* command_line);

}

#endif
