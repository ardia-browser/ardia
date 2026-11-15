// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MAIN_DELEGATE_H_
#define ARDIA_LINUX_MAIN_DELEGATE_H_

#include <optional>

#include "chrome/app/chrome_main_delegate.h"
#include "chrome/app/startup_timestamps.h"

namespace ardia_linux {

class MainDelegate : public ChromeMainDelegate {
 public:
  explicit MainDelegate(const StartupTimestamps& timestamps);
  MainDelegate(const MainDelegate&) = delete;
  MainDelegate& operator=(const MainDelegate&) = delete;
  ~MainDelegate() override;

 protected:
  std::optional<int> BasicStartupComplete() override;
  void PreSandboxStartup() override;
  content::ContentBrowserClient* CreateContentBrowserClient() override;
  content::ContentRendererClient* CreateContentRendererClient() override;
};

}

#endif
