#ifndef ARDIA_CORE_AC_DISCARD_VETO_H_
#define ARDIA_CORE_AC_DISCARD_VETO_H_

#include <utility>
#include <vector>

#include "base/time/time.h"

namespace content {
class NavigationHandle;
class WebContents;
}

namespace ardiacore {

enum class DiscardVeto {
  kPostedDocument = 100,
  kBeforeUnload = 101,
  kDownload = 102,
  kCliHold = 103,
};

std::vector<DiscardVeto> DiscardVetoesFor(content::WebContents* contents);

void NotePostedDocument(content::NavigationHandle* handle);

std::vector<bool> SetCliHeldTabs(
    const std::vector<std::pair<content::WebContents*, base::Time>>& held);

int TakeCliHoldVetoes();

void InstallDiscardVeto();

class ScopedDiscardVetoBypass {
 public:
  ScopedDiscardVetoBypass();
  ScopedDiscardVetoBypass(const ScopedDiscardVetoBypass&) = delete;
  ScopedDiscardVetoBypass& operator=(const ScopedDiscardVetoBypass&) = delete;
  ~ScopedDiscardVetoBypass();

 private:
  bool was_bypassed_;
};

}

#endif
