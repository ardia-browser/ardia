#ifndef ARDIA_CORE_AC_DISCARD_VETO_H_
#define ARDIA_CORE_AC_DISCARD_VETO_H_

#include <vector>

namespace content {
class NavigationHandle;
class WebContents;
}

namespace ardiacore {

enum class DiscardVeto {
  kPostedDocument = 100,
  kBeforeUnload = 101,
  kDownload = 102,
};

std::vector<DiscardVeto> DiscardVetoesFor(content::WebContents* contents);

void NotePostedDocument(content::NavigationHandle* handle);

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
