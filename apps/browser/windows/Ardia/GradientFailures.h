#pragma once

#include <NativeModules.h>

#include <mutex>

#include "Events.h"
#include "MaterialSupport.h"

namespace Ardia::Materials {

struct GradientFailureSink {
  std::mutex lock;
  winrt::Microsoft::ReactNative::ReactContext context{nullptr};

  static GradientFailureSink &Shared() noexcept {
    static GradientFailureSink *sink = new GradientFailureSink();
    return *sink;
  }
};

inline void ReportGradientFailuresTo(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
  GradientFailureSink &sink = GradientFailureSink::Shared();
  std::scoped_lock guard{sink.lock};
  sink.context = context;
}

inline void MarkGradientFailed() noexcept {
  if (GradientFailed().exchange(true)) return;
  winrt::Microsoft::ReactNative::ReactContext context{nullptr};
  {
    GradientFailureSink &sink = GradientFailureSink::Shared();
    std::scoped_lock guard{sink.lock};
    context = sink.context;
  }
  if (context) EmitEvent(context, L"ArdiaMaterials", L"gradientFailed", winrt::Microsoft::ReactNative::JSValueObject{});
}

}
