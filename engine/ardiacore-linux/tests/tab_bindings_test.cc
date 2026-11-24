#include <cassert>
#include <cstdio>
#include <map>
#include <memory>
#include <set>

#include "ardia/linux/ac_linux_tab_bindings.h"

namespace tab_bindings = ardiacore::linux_tab_bindings;

struct Binding;
using Bindings = std::map<int, std::unique_ptr<Binding>>;

struct Binding {
  Binding(Bindings* owner, std::map<int, bool>* focus, int id, int* destroyed)
      : owner(owner), focus(focus), id(id), destroyed(destroyed) {}
  Binding(const Binding&) = delete;
  Binding& operator=(const Binding&) = delete;
  ~Binding() {
    assert(!owner->contains(id));
    assert(!focus->contains(id));
    assert(!tab_bindings::TakeBinding(*owner, this, *focus));
    for (const auto& [other, binding] : *owner) assert(binding && binding.get() != this);
    ++*destroyed;
  }
  Bindings* owner;
  std::map<int, bool>* focus;
  int id;
  int* destroyed;
};

int main() {
  Bindings bindings;
  std::map<int, bool> focus;
  std::set<int> released;
  int destroyed = 0;
  for (int id = 1; id <= 3; ++id) {
    bindings[id] = std::make_unique<Binding>(&bindings, &focus, id, &destroyed);
    focus[id] = true;
    released.insert(id);
  }
  Binding* middle = bindings[2].get();
  auto owned = tab_bindings::TakeBinding(bindings, middle, focus, released);
  assert(owned.get() == middle && bindings.size() == 2 && !focus.contains(2) && !released.contains(2));
  assert(focus.contains(1) && released.contains(3));
  owned.reset();
  assert(destroyed == 1);
  assert(!tab_bindings::TakeBinding(bindings, middle, focus));
  assert(!tab_bindings::TakeBinding<Binding>(bindings, nullptr, focus));
  Bindings elsewhere;
  {
    Binding stranger(&elsewhere, &focus, 9, &destroyed);
    assert(!tab_bindings::TakeBinding(bindings, &stranger, focus) && bindings.size() == 2);
  }
  assert(destroyed == 2);
  for (int round = 0; round < 1000; ++round) {
    const int id = 100 + round;
    bindings[id] = std::make_unique<Binding>(&bindings, &focus, id, &destroyed);
    focus[id] = round % 2;
    tab_bindings::TakeBinding(bindings, bindings[id].get(), focus).reset();
    assert(bindings.size() == 2 && focus.size() == 2);
  }
  assert(destroyed == 1002);
  while (!bindings.empty()) tab_bindings::TakeBinding(bindings, bindings.begin()->second.get(), focus).reset();
  assert(destroyed == 1004 && focus.empty());
  std::puts("ok");
}
