// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/telemetry_files.h"

#include <algorithm>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "third_party/re2/src/re2/re2.h"

namespace ardia_linux {

namespace {

int64_t NewlinesIn(std::string_view text) {
  return std::ranges::count(text, '\n');
}

std::string DayOfFile(const std::string& name) {
  std::string_view rest(name);
  if (base::StartsWith(rest, "cli-")) {
    rest.remove_prefix(4);
  }
  return std::string(rest.substr(0, 10));
}

}

bool IsTelemetryDay(std::string_view day) {
  static const base::NoDestructor<re2::RE2> pattern(R"(\d{4}-\d{2}-\d{2})");
  return re2::RE2::FullMatch(day, *pattern);
}

std::string UtcDay(base::Time at) {
  base::Time::Exploded exploded;
  at.UTCExplode(&exploded);
  return base::StringPrintf("%04d-%02d-%02d", exploded.year, exploded.month,
                            exploded.day_of_month);
}

TelemetryFiles::TelemetryFiles(base::FilePath folder)
    : folder_(std::move(folder)) {}

std::vector<TelemetryFiles::DayFile> TelemetryFiles::Files() const {
  static const base::NoDestructor<re2::RE2> name_pattern(
      R"((cli-)?\d{4}-\d{2}-\d{2}\.jsonl)");
  std::vector<DayFile> files;
  base::FileEnumerator found(folder_, false, base::FileEnumerator::FILES);
  for (base::FilePath path = found.Next(); !path.empty(); path = found.Next()) {
    const std::string name = path.BaseName().value();
    if (!re2::RE2::FullMatch(name, *name_pattern)) {
      continue;
    }
    files.push_back({path, DayOfFile(name), found.GetInfo().GetSize()});
  }
  std::ranges::sort(files, [](const DayFile& a, const DayFile& b) {
    return a.day != b.day ? a.day < b.day : a.path < b.path;
  });
  return files;
}

void TelemetryFiles::Append(std::string_view day,
                            const std::vector<std::string>& lines) {
  if (!IsTelemetryDay(day) || lines.empty()) {
    return;
  }
  base::CreateDirectory(folder_);
  std::string text;
  for (const std::string& line : lines) {
    text += line;
    if (!base::EndsWith(line, "\n")) {
      text += "\n";
    }
  }
  const base::FilePath path = folder_.Append(std::string(day) + ".jsonl");
  if (!base::PathExists(path)) {
    base::WriteFile(path, text);
    return;
  }
  base::AppendToFile(path, text);
}

TelemetryPruned TelemetryFiles::Prune(base::Time now,
                                      int64_t max_bytes,
                                      base::TimeDelta keep) {
  TelemetryPruned pruned;
  const std::string oldest = UtcDay(now - keep);
  for (const DayFile& file : Files()) {
    if (file.day < oldest) {
      std::string text;
      base::ReadFileToString(file.path, &text);
      pruned.dropped_lines += NewlinesIn(text);
      base::DeleteFile(file.path);
    }
  }
  std::vector<DayFile> kept = Files();
  int64_t total = 0;
  for (const DayFile& file : kept) {
    total += file.bytes;
  }
  while (total > max_bytes && !kept.empty()) {
    DayFile first = kept.front();
    kept.erase(kept.begin());
    std::string text;
    base::ReadFileToString(first.path, &text);
    const int64_t excess = total - max_bytes;
    if (excess >= first.bytes || kept.empty()) {
      pruned.dropped_lines += NewlinesIn(text);
      base::DeleteFile(first.path);
      total -= first.bytes;
      continue;
    }
    const size_t cut = text.find('\n', static_cast<size_t>(excess));
    const std::string tail =
        cut == std::string::npos ? std::string() : text.substr(cut + 1);
    pruned.dropped_lines += NewlinesIn(
        std::string_view(text).substr(0, cut == std::string::npos
                                             ? text.size()
                                             : cut + 1));
    base::WriteFile(first.path, tail);
    total -= first.bytes - static_cast<int64_t>(tail.size());
  }
  for (const DayFile& file : Files()) {
    std::string text;
    base::ReadFileToString(file.path, &text);
    pruned.bytes += static_cast<int64_t>(text.size());
    pruned.lines += NewlinesIn(text);
    ++pruned.files;
  }
  return pruned;
}

std::string TelemetryFiles::Collect(base::Time since, int64_t* lines) const {
  static const base::NoDestructor<re2::RE2> at_pattern(R"(^\{"at":(\d+))");
  const std::string first_day = UtcDay(since);
  const double since_ms = since.InMillisecondsFSinceUnixEpoch();
  std::string data;
  int64_t count = 0;
  for (const DayFile& file : Files()) {
    if (file.day < first_day) {
      continue;
    }
    std::string text;
    base::ReadFileToString(file.path, &text);
    for (std::string_view line : base::SplitStringPiece(
             text, "\n", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
      int64_t at = 0;
      if (re2::RE2::PartialMatch(line, *at_pattern, &at) &&
          static_cast<double>(at) < since_ms) {
        continue;
      }
      data.append(line).append("\n");
      ++count;
    }
  }
  if (lines) {
    *lines = count;
  }
  return data;
}

void TelemetryFiles::Clear() {
  base::DeletePathRecursively(folder_);
}

}
