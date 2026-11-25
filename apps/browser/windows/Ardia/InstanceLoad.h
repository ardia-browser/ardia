#pragma once

#include <functional>
#include <string>
#include <vector>

#include "Host.h"
#include "LaunchLog.h"

namespace Ardia {

struct InstanceLoad {
  bool loaded = false;
  std::vector<std::function<void()>> waiting;

  static InstanceLoad &Shared() noexcept {
    static InstanceLoad *shared = new InstanceLoad();
    return *shared;
  }

  static void Start() noexcept {
    try {
      auto loading = Host::Current()->reactHost.ReloadInstance();
      loading.Completed([](auto const &, auto const &) noexcept {
        Host::Current()->queue.DispatcherQueue().TryEnqueue([]() noexcept { Shared().Finished(); });
      });
    } catch (...) {
      Shared().Finished();
    }
  }

  void WhenLoaded(std::wstring const &what, std::function<void()> work) noexcept {
    if (loaded) return work();
    const ULONGLONG asked = GetTickCount64();
    waiting.push_back([what, asked, work = std::move(work)]() {
      LaunchLog::Write(L"launch", what + L" waited " + std::to_wstring(GetTickCount64() - asked) + L" ms for the instance to finish loading");
      work();
    });
  }

  void Finished() noexcept {
    if (loaded) return;
    loaded = true;
    LaunchLog::Write(L"launch", L"instance loaded");
    auto ready = std::move(waiting);
    waiting.clear();
    for (auto &work : ready) work();
  }
};

}
