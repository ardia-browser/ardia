#ifndef ARDIA_WIN_KEPT_PAGES_H_
#define ARDIA_WIN_KEPT_PAGES_H_

#include <vector>

namespace performance_manager {
class PageNode;
}

namespace performance_manager::policies {
extern bool (*g_ardia_keeps_page)(const PageNode* page_node);
}

namespace ardia_win {

inline constexpr int kOpensLivePage = 100;
inline constexpr int kUnsavedAfterUse = 101;
inline constexpr int kHoldsWebLock = 102;
inline constexpr int kHoldsBlockingIndexedDBLock = 103;
inline constexpr int kLiveConnection = 104;
inline constexpr int kInspectedByAnotherClient = 105;

std::vector<int> KeptBy(const performance_manager::PageNode* page);

void AskBeforeDiscards();

}

#endif
