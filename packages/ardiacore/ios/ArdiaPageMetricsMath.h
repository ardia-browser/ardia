#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace ardia_page_metrics {

constexpr double kMostPerMessage = 1000000;
constexpr int kMediaErrorKinds = 5;
constexpr uint32_t kMostGeneration = 2147483647;

struct Batch {
  double generation = NAN;
  double errors[kMediaErrorKinds] = {NAN, NAN, NAN, NAN, NAN};
  double dropped = NAN;
  double frames = NAN;
  double scrolls = NAN;
  double scrollFrames = NAN;
  double scrollMs = NAN;
};

struct Counts {
  bool accepted = false;
  double errors[kMediaErrorKinds] = {0, 0, 0, 0, 0};
  double dropped = 0;
  double frames = 0;
  double scrolls = 0;
  double scrollFrames = 0;
  double scrollMs = 0;
};

inline double Count(double value) {
  return std::isfinite(value) && value > 0 ? std::floor(std::min(value, kMostPerMessage)) : 0;
}

inline uint32_t NextGeneration(uint32_t current) {
  return current >= kMostGeneration ? 1 : current + 1;
}

inline Counts Accept(bool mainFrame, uint32_t currentGeneration, const Batch &batch) {
  Counts out;
  if (!mainFrame || currentGeneration == 0 || !std::isfinite(batch.generation) || batch.generation != static_cast<double>(currentGeneration)) return out;
  out.accepted = true;
  for (int i = 0; i < kMediaErrorKinds; i++) out.errors[i] = Count(batch.errors[i]);
  out.frames = Count(batch.frames);
  out.dropped = std::min(Count(batch.dropped), out.frames);
  const double scrollFrames = Count(batch.scrollFrames);
  const double scrollMs = Count(batch.scrollMs);
  if (scrollFrames > 0 && scrollMs > 0) {
    out.scrolls = Count(batch.scrolls);
    out.scrollFrames = scrollFrames;
    out.scrollMs = scrollMs;
  }
  return out;
}

}
