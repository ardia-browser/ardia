#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "CrashDumps.h"

namespace {

void Print(const Ardia::CrashDumps::Report &report) {
  std::printf("report\n");
  std::printf("incidentId\t%s\n", report.incidentId.c_str());
  std::printf("time\t%.0f\n", report.time);
  std::printf("fileTime\t%.0f\n", report.fileTime);
  std::printf("process\t%s\n", report.process.c_str());
  std::printf("terminationNamespace\t%s\n", report.terminationNamespace.c_str());
  std::printf("signal\t%s\n", report.signal.c_str());
  std::printf("exceptionSubtype\t%s\n", report.exceptionSubtype.c_str());
  std::printf("engineVersion\t%s\n", report.engineVersion.c_str());
  std::printf("appVersion\t%s\n", report.appVersion.c_str());
  if (report.uptimeSeconds) std::printf("uptimeSeconds\t%lld\n", static_cast<long long>(*report.uptimeSeconds));
  for (const auto &frame : report.frames) {
    std::printf("frame\t%s", frame.image.c_str());
    if (frame.offset) std::printf("\t%llu", static_cast<unsigned long long>(*frame.offset));
    std::printf("\n");
  }
  std::printf("end\n");
}

}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  std::string mode = argv[1];
  if (mode == "name") {
    std::printf("%d\n", Ardia::CrashDumps::IsDumpFileName(argv[2]) ? 1 : 0);
    return 0;
  }
  if (mode == "hex") {
    auto bytes = Ardia::CrashDumps::DecodeHex(argv[2]);
    if (bytes) std::printf("%zu\n", bytes->size());
    else std::printf("none\n");
    return 0;
  }
  if (mode == "collect") {
    double since = std::strtod(argv[2], nullptr);
    std::vector<std::filesystem::path> folders;
    for (int index = 3; index < argc; ++index) folders.emplace_back(argv[index]);
    for (const auto &report : Ardia::CrashDumps::Collect(folders, since)) Print(report);
    return 0;
  }
  return 2;
}
