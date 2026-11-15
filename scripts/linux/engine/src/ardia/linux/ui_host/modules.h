#ifndef ARDIA_LINUX_UI_HOST_MODULES_H_
#define ARDIA_LINUX_UI_HOST_MODULES_H_

#include <map>
#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/observer_list.h"
#include "base/observer_list_types.h"
#include "base/sequence_checker.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "base/values.h"

namespace ardia_linux {

struct ModuleError {
  std::string message;
  std::string code = "ERR_LINUX_NATIVE";
};

using ModuleResult = base::expected<base::Value, ModuleError>;

ModuleResult ModuleFailure(std::string_view message,
                           std::string_view code = "ERR_LINUX_NATIVE");

using ModuleReply = base::OnceCallback<void(ModuleResult)>;

using SyncMethod =
    base::RepeatingCallback<ModuleResult(const base::ListValue& args)>;

using AsyncMethod =
    base::RepeatingCallback<void(base::ListValue args, ModuleReply reply)>;

class ModuleEventSink : public base::CheckedObserver {
 public:
  virtual void OnModuleEvent(std::string_view module,
                             std::string_view event,
                             const base::Value& payload) = 0;
};

class ModuleRegistry {
 public:
  class Module {
   public:
    Module& Sync(std::string_view method, SyncMethod run);
    Module& Async(std::string_view method, AsyncMethod run);
    Module& Constant(std::string_view name, base::Value value);

   private:
    friend class ModuleRegistry;
    Module(ModuleRegistry* registry, std::string name);

    raw_ptr<ModuleRegistry> registry_;
    std::string name_;
  };

  struct SyncTimings {
    int calls = 0;
    int slow = 0;
  };

  static constexpr base::TimeDelta kSlowSyncCall = base::Milliseconds(4);

  ModuleRegistry();
  ModuleRegistry(const ModuleRegistry&) = delete;
  ModuleRegistry& operator=(const ModuleRegistry&) = delete;
  ~ModuleRegistry();

  static ModuleRegistry& Get();
  static bool Exists();

  Module Define(std::string_view module);

  void Emit(std::string_view module,
            std::string_view event,
            base::Value payload = base::Value());

  base::DictValue Shapes() const;
  bool Has(std::string_view module) const;

  ModuleResult CallSync(std::string_view module,
                        std::string_view method,
                        const base::ListValue& args);
  void Call(std::string_view module,
            std::string_view method,
            base::ListValue args,
            ModuleReply reply);

  void AddEventSink(ModuleEventSink* sink);
  void RemoveEventSink(ModuleEventSink* sink);

  SyncTimings TakeSyncTimings();

 private:
  struct Entry {
    std::map<std::string, SyncMethod, std::less<>> sync;
    std::map<std::string, AsyncMethod, std::less<>> async;
    base::DictValue constants;
  };

  Entry& EntryFor(std::string_view module);

  std::map<std::string, Entry, std::less<>> modules_;
  base::ObserverList<ModuleEventSink> sinks_;
  SyncTimings sync_timings_;
  SEQUENCE_CHECKER(sequence_checker_);
};

void RegisterAppModules(ModuleRegistry& registry);

}

#endif
