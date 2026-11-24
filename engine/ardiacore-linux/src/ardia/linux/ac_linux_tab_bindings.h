#ifndef ARDIA_LINUX_AC_LINUX_TAB_BINDINGS_H_
#define ARDIA_LINUX_AC_LINUX_TAB_BINDINGS_H_

#include <map>
#include <memory>
#include <utility>

namespace ardiacore::linux_tab_bindings {

template <typename Binding, typename... PerTab>
std::unique_ptr<Binding> TakeBinding(std::map<int, std::unique_ptr<Binding>>& bindings, const Binding* binding,
                                     PerTab&... per_tab) {
  if (!binding) return nullptr;
  for (auto entry = bindings.begin(); entry != bindings.end(); ++entry) {
    if (entry->second.get() != binding) continue;
    const int id = entry->first;
    std::unique_ptr<Binding> owned = std::move(entry->second);
    bindings.erase(entry);
    (per_tab.erase(id), ...);
    return owned;
  }
  return nullptr;
}

}

#endif
