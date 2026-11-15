// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/telemetry_files.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/strings/string_number_conversions.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

base::Time Day(int day_of_month, int hour = 12) {
  base::Time::Exploded exploded = {};
  exploded.year = 2026;
  exploded.month = 11;
  exploded.day_of_month = day_of_month;
  exploded.hour = hour;
  base::Time time;
  EXPECT_TRUE(base::Time::FromUTCExploded(exploded, &time));
  return time;
}

std::string Line(base::Time at, int n) {
  return "{\"at\":" +
         base::NumberToString(static_cast<int64_t>(
             at.InMillisecondsFSinceUnixEpoch())) +
         ",\"n\":" + base::NumberToString(n) + "}";
}

TEST(TelemetryFilesTest, DaysAreValidatedAndLinesAppendPerDay) {
  base::ScopedTempDir folder;
  ASSERT_TRUE(folder.CreateUniqueTempDir());
  TelemetryFiles files(folder.GetPath().Append("local"));
  EXPECT_TRUE(IsTelemetryDay("2026-11-15"));
  EXPECT_FALSE(IsTelemetryDay("../x"));
  EXPECT_EQ(UtcDay(Day(15)), "2026-11-15");
  files.Append("2026-11-15", {Line(Day(15), 1), Line(Day(15), 2)});
  files.Append("2026-11-15", {Line(Day(15), 3) + "\n"});
  files.Append("../evil", {"x"});
  std::string text;
  ASSERT_TRUE(base::ReadFileToString(
      folder.GetPath().Append("local").Append("2026-11-15.jsonl"), &text));
  EXPECT_EQ(std::ranges::count(text, '\n'), 3);
  EXPECT_FALSE(base::PathExists(folder.GetPath().Append("evil.jsonl")));
}

TEST(TelemetryFilesTest, PruneDropsOldDaysThenTrimsTheOldestToTheCap) {
  base::ScopedTempDir folder;
  ASSERT_TRUE(folder.CreateUniqueTempDir());
  TelemetryFiles files(folder.GetPath());
  files.Append("2026-10-01", {Line(Day(1), 0)});
  std::vector<std::string> many;
  for (int i = 0; i < 10; ++i) {
    many.push_back(Line(Day(14), i));
  }
  files.Append("2026-11-14", many);
  files.Append("2026-11-15", {Line(Day(15), 99)});
  const TelemetryPruned pruned =
      files.Prune(Day(15), 200, base::Days(30));
  EXPECT_EQ(pruned.files, 2);
  EXPECT_LE(pruned.bytes, 200);
  EXPECT_GE(pruned.dropped_lines, 1);
  int64_t lines = 0;
  const std::string kept = files.Collect(Day(1), &lines);
  EXPECT_EQ(lines, pruned.lines);
  EXPECT_NE(kept.find("\"n\":99"), std::string::npos);
}

TEST(TelemetryFilesTest, CollectSkipsLinesBeforeSince) {
  base::ScopedTempDir folder;
  ASSERT_TRUE(folder.CreateUniqueTempDir());
  TelemetryFiles files(folder.GetPath());
  files.Append("2026-11-15", {Line(Day(15, 1), 1), Line(Day(15, 20), 2)});
  int64_t lines = 0;
  const std::string data = files.Collect(Day(15, 12), &lines);
  EXPECT_EQ(lines, 1);
  EXPECT_NE(data.find("\"n\":2"), std::string::npos);
  files.Clear();
  EXPECT_FALSE(base::PathExists(folder.GetPath()));
}

}

}
