#pragma once

namespace base {

struct Feature {
  const char* const name;
};

template <typename T>
struct FeatureParam {
  const Feature* const feature;
  const char* const name;
};

enum class UnretainedDanglingPtrModeStub { kCrash, kDumpWithoutCrashing };

namespace features {
inline constexpr Feature kPartitionAllocUnretainedDanglingPtr{"PartitionAllocUnretainedDanglingPtr"};
inline constexpr FeatureParam<UnretainedDanglingPtrModeStub> kUnretainedDanglingPtrModeParam{
    &kPartitionAllocUnretainedDanglingPtr, "mode"};
}

}
