#include "ardia/linux/ui_host/modules.h"

#include <utility>

#include "base/check.h"
#include "base/strings/strcat.h"
#include "base/threading/thread_restrictions.h"
#include "base/time/time.h"

namespace ardia_linux {

namespace {

ModuleRegistry* g_registry = nullptr;

}

ModuleResult ModuleFailure(std::string_view message, std::string_view code) {
  return base::unexpected(
      ModuleError{std::string(message), std::string(code)});
}

ModuleRegistry::Module::Module(ModuleRegistry* registry, std::string name)
    : registry_(registry), name_(std::move(name)) {}

ModuleRegistry::Module& ModuleRegistry::Module::Sync(std::string_view method,
                                                     SyncMethod run) {
  registry_->EntryFor(name_).sync.insert_or_assign(std::string(method),
                                                   std::move(run));
  return *this;
}

ModuleRegistry::Module& ModuleRegistry::Module::Async(std::string_view method,
                                                      AsyncMethod run) {
  registry_->EntryFor(name_).async.insert_or_assign(std::string(method),
                                                    std::move(run));
  return *this;
}

ModuleRegistry::Module& ModuleRegistry::Module::Constant(std::string_view name,
                                                         base::Value value) {
  registry_->EntryFor(name_).constants.Set(name, std::move(value));
  return *this;
}

ModuleRegistry::ModuleRegistry() {
  CHECK(!g_registry);
  g_registry = this;
}

ModuleRegistry::~ModuleRegistry() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  g_registry = nullptr;
}

ModuleRegistry& ModuleRegistry::Get() {
  CHECK(g_registry);
  return *g_registry;
}

bool ModuleRegistry::Exists() {
  return g_registry != nullptr;
}

ModuleRegistry::Module ModuleRegistry::Define(std::string_view module) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  EntryFor(module);
  return Module(this, std::string(module));
}

ModuleRegistry::Entry& ModuleRegistry::EntryFor(std::string_view module) {
  auto found = modules_.find(module);
  if (found == modules_.end()) {
    found = modules_.emplace(std::string(module), Entry()).first;
  }
  return found->second;
}

void ModuleRegistry::Emit(std::string_view module,
                          std::string_view event,
                          base::Value payload) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  for (ModuleEventSink& sink : sinks_) {
    sink.OnModuleEvent(module, event, payload);
  }
}

base::DictValue ModuleRegistry::Shapes() const {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  base::DictValue shapes;
  for (const auto& [name, entry] : modules_) {
    base::ListValue sync;
    for (const auto& [method, run] : entry.sync) {
      sync.Append(method);
    }
    base::ListValue async;
    for (const auto& [method, run] : entry.async) {
      async.Append(method);
    }
    base::DictValue shape;
    shape.Set("sync", std::move(sync));
    shape.Set("async", std::move(async));
    shape.Set("constants", entry.constants.Clone());
    shapes.Set(name, std::move(shape));
  }
  return shapes;
}

bool ModuleRegistry::Has(std::string_view module) const {
  return modules_.contains(module);
}

ModuleResult ModuleRegistry::CallSync(std::string_view module,
                                      std::string_view method,
                                      const base::ListValue& args) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto entry = modules_.find(module);
  if (entry == modules_.end()) {
    return ModuleFailure(base::StrCat({module, " is not on Linux"}));
  }
  auto run = entry->second.sync.find(method);
  if (run == entry->second.sync.end()) {
    return ModuleFailure(
        base::StrCat({module, ".", method, " has no sync version on Linux"}));
  }
  base::TimeTicks started = base::TimeTicks::Now();
  ModuleResult result = [&] {
    base::ScopedDisallowBlocking no_disk_in_sync_calls;
    return run->second.Run(args);
  }();
  ++sync_timings_.calls;
  if (base::TimeTicks::Now() - started > kSlowSyncCall) {
    ++sync_timings_.slow;
  }
  return result;
}

void ModuleRegistry::Call(std::string_view module,
                          std::string_view method,
                          base::ListValue args,
                          ModuleReply reply) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  auto entry = modules_.find(module);
  if (entry == modules_.end()) {
    std::move(reply).Run(
        ModuleFailure(base::StrCat({module, " is not on Linux"})));
    return;
  }
  if (auto run = entry->second.async.find(method);
      run != entry->second.async.end()) {
    run->second.Run(std::move(args), std::move(reply));
    return;
  }
  if (entry->second.sync.contains(method)) {
    std::move(reply).Run(CallSync(module, method, args));
    return;
  }
  std::move(reply).Run(
      ModuleFailure(base::StrCat({module, ".", method, " is not on Linux"})));
}

void ModuleRegistry::AddEventSink(ModuleEventSink* sink) {
  sinks_.AddObserver(sink);
}

void ModuleRegistry::RemoveEventSink(ModuleEventSink* sink) {
  sinks_.RemoveObserver(sink);
}

ModuleRegistry::SyncTimings ModuleRegistry::TakeSyncTimings() {
  return std::exchange(sync_timings_, SyncTimings());
}

}
