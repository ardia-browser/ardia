// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MAIN_PARTS_H_
#define ARDIA_LINUX_MAIN_PARTS_H_

#include <memory>

#include "chrome/browser/chrome_browser_main_extra_parts.h"

namespace ardia_linux {

class ModuleRegistry;

class MainParts : public ChromeBrowserMainExtraParts {
 public:
  MainParts();
  MainParts(const MainParts&) = delete;
  MainParts& operator=(const MainParts&) = delete;
  ~MainParts() override;

  void PreBrowserStart() override;
  void PostBrowserStart() override;
  void PostMainMessageLoopRun() override;

 private:
  std::unique_ptr<ModuleRegistry> registry_;
};

}

#endif
