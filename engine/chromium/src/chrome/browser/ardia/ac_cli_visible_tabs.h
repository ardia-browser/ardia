// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_VISIBLE_TABS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_VISIBLE_TABS_H_

#include <string>

namespace content {
class WebContents;
}

namespace ardia {

enum class PluginTabHold {
  kOk,
  kNoCredential,
  kOutOfScope,
  kNoSession,
  kInProgress,
};

PluginTabHold SetPluginTabVisibleHold(const std::string& credential_id,
                                      content::WebContents* contents,
                                      bool on);

void PluginTabDeparted(const std::string& credential_id,
                       content::WebContents* contents);

void ReleasePluginTabVisibleHolds(const std::string& credential_id);

int PluginTabVisibleHoldCount();

bool PluginTabVisibleHoldHeld(const std::string& credential_id,
                              content::WebContents* contents);

void InstallCliVisibleTabs();

}

#endif
