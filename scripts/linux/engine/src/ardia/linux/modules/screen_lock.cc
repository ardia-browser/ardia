// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/screen_lock.h"

#include <unistd.h>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/dbus/signal_watch.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/environment.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/power_monitor/power_monitor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/system/sys_info.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "components/dbus/thread_linux/dbus_thread_linux.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_path.h"
#include "dbus/object_proxy.h"
#include "ui/base/idle/idle.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaSystemSignals";
constexpr char kLogind[] = "org.freedesktop.login1";
constexpr char kLogindPath[] = "/org/freedesktop/login1";
constexpr char kLogindManager[] = "org.freedesktop.login1.Manager";
constexpr char kLogindSession[] = "org.freedesktop.login1.Session";
constexpr char kLogindUser[] = "org.freedesktop.login1.User";
constexpr char kProperties[] = "org.freedesktop.DBus.Properties";
constexpr char kLockedHint[] = "LockedHint";
constexpr const char* kScreenSavers[] = {
    "org.freedesktop.ScreenSaver",
    "org.gnome.ScreenSaver",
    "org.xfce.ScreenSaver",
};
constexpr int kCallTimeoutMs = 10000;
constexpr base::TimeDelta kIdlePoll = base::Seconds(5);

void EmitSignal(base::DictValue payload) {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().Emit(kModule, "onSystemSignal",
                               base::Value(std::move(payload)));
  }
}

void EmitAppEvent(std::string_view type) {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().Emit("ArdiaShell", "onAppEvent",
                               base::Value(base::DictValue().Set("type", type)));
  }
}

class SystemSignals {
 public:
  static SystemSignals& Get() {
    static base::NoDestructor<SystemSignals> signals;
    return *signals;
  }

  void AddLeaveListener(base::RepeatingClosure listener) {
    leave_listeners_.push_back(std::move(listener));
  }

  void Start() {
    if (started_) {
      return;
    }
    started_ = true;
    pending_sources_ = 2;
    session_bus_ = dbus_thread_linux::GetSharedSessionBus();
    system_bus_ = dbus_thread_linux::GetSharedSystemBus();
    std::vector<std::string> saver_rules;
    std::set<SignalWatch::Member> saver_members;
    for (const char* saver : kScreenSavers) {
      saver_rules.push_back(
          SignalWatch::SignalRule("", "", saver, "ActiveChanged"));
      saver_members.insert({saver, "ActiveChanged"});
    }
    saver_watch_ = std::make_unique<SignalWatch>(
        session_bus_, std::move(saver_rules), std::move(saver_members),
        base::BindRepeating(&SystemSignals::ScreenSaverSignal,
                            weak_factory_.GetWeakPtr()),
        base::BindOnce(&SystemSignals::SourceStarted,
                       weak_factory_.GetWeakPtr(), "screenSaver"));
    sleep_watch_ = std::make_unique<SignalWatch>(
        system_bus_,
        std::vector<std::string>{SignalWatch::SignalRule(
            kLogind, kLogindPath, kLogindManager, "PrepareForSleep")},
        std::set<SignalWatch::Member>{{kLogindManager, "PrepareForSleep"}},
        base::BindRepeating(&SystemSignals::SleepSignal,
                            weak_factory_.GetWeakPtr()),
        base::DoNothing());
    std::unique_ptr<base::Environment> environment = base::Environment::Create();
    FindSession(environment->GetVar("XDG_SESSION_ID").value_or(std::string()),
                0);
  }

  void WatchIdle(std::vector<int> thresholds) {
    idle_thresholds_ = std::move(thresholds);
    idle_now_.clear();
    for (int threshold : idle_thresholds_) {
      idle_now_[threshold] = false;
    }
    idle_timer_.Stop();
    if (!idle_thresholds_.empty()) {
      idle_timer_.Start(FROM_HERE, kIdlePoll,
                        base::BindRepeating(&SystemSignals::PollIdle,
                                            base::Unretained(this)));
    }
  }

  void SetAsleep(bool asleep) {
    if (asleep_ == asleep) {
      return;
    }
    asleep_ = asleep;
    EmitSignal(base::DictValue().Set("type", asleep ? "sleep" : "wake"));
    if (asleep) {
      Note("screenLock", "the system is going to sleep");
      EmitAppEvent("lockedOrAsleep");
      OwnerLeft();
    }
  }

  void Locked(std::string_view source) {
    CountLinux("screen_locks_seen");
    Note("screenLock", base::StrCat({"the session locked (", source, ")"}));
    EmitAppEvent("lockedOrAsleep");
    EmitAppEvent("screenLocked");
    OwnerLeft();
  }

  bool hold_incoming_links = false;
  std::vector<base::FilePath> approved_folders;

 private:
  friend class base::NoDestructor<SystemSignals>;
  SystemSignals() = default;

  void OwnerLeft() {
    std::vector<base::RepeatingClosure> listeners = leave_listeners_;
    for (const base::RepeatingClosure& listener : listeners) {
      listener.Run();
    }
  }

  void PollIdle() {
    const int idle_seconds = ui::CalculateIdleTime();
    for (int threshold : idle_thresholds_) {
      const bool idle = idle_seconds >= threshold;
      if (idle_now_[threshold] == idle) {
        continue;
      }
      idle_now_[threshold] = idle;
      EmitSignal(base::DictValue()
                     .Set("type", "idle")
                     .Set("threshold", threshold)
                     .Set("idle", idle));
    }
  }

  dbus::ObjectProxy* Manager() {
    return system_bus_->GetObjectProxy(kLogind,
                                       dbus::ObjectPath(kLogindPath));
  }

  void FindSession(std::string session_id, int attempt) {
    if (attempt == 0 && session_id.empty()) {
      attempt = 1;
    }
    if (attempt == 0) {
      dbus::MethodCall call(kLogindManager, "GetSession");
      dbus::MessageWriter(&call).AppendString(session_id);
      Manager()->CallMethod(
          &call, kCallTimeoutMs,
          base::BindOnce(&SystemSignals::SessionPathAnswered,
                         weak_factory_.GetWeakPtr(), session_id, attempt));
      return;
    }
    if (attempt == 1) {
      dbus::MethodCall call(kLogindManager, "GetSessionByPID");
      dbus::MessageWriter(&call).AppendUint32(static_cast<uint32_t>(getpid()));
      Manager()->CallMethod(
          &call, kCallTimeoutMs,
          base::BindOnce(&SystemSignals::SessionPathAnswered,
                         weak_factory_.GetWeakPtr(), session_id, attempt));
      return;
    }
    if (attempt == 2) {
      dbus::MethodCall call(kLogindManager, "GetUser");
      dbus::MessageWriter(&call).AppendUint32(static_cast<uint32_t>(getuid()));
      Manager()->CallMethod(
          &call, kCallTimeoutMs,
          base::BindOnce(&SystemSignals::UserAnswered,
                         weak_factory_.GetWeakPtr()));
      return;
    }
    SourceStarted("logind", false, "no logind session");
  }

  void SessionPathAnswered(std::string session_id,
                           int attempt,
                           dbus::Response* response) {
    dbus::ObjectPath path;
    if (response && dbus::MessageReader(response).PopObjectPath(&path) &&
        path.IsValid()) {
      WatchSession(path);
      return;
    }
    FindSession(std::move(session_id), attempt + 1);
  }

  void UserAnswered(dbus::Response* response) {
    dbus::ObjectPath user;
    if (!response || !dbus::MessageReader(response).PopObjectPath(&user)) {
      FindSession(std::string(), 3);
      return;
    }
    dbus::MethodCall call(kProperties, "Get");
    dbus::MessageWriter writer(&call);
    writer.AppendString(kLogindUser);
    writer.AppendString("Display");
    system_bus_->GetObjectProxy(kLogind, user)
        ->CallMethod(&call, kCallTimeoutMs,
                     base::BindOnce(&SystemSignals::DisplayAnswered,
                                    weak_factory_.GetWeakPtr()));
  }

  void DisplayAnswered(dbus::Response* response) {
    if (response) {
      dbus::MessageReader reader(response);
      dbus::MessageReader variant(nullptr);
      dbus::MessageReader display(nullptr);
      std::string id;
      dbus::ObjectPath path;
      if (reader.PopVariant(&variant) && variant.PopStruct(&display) &&
          display.PopString(&id) && display.PopObjectPath(&path) &&
          path.IsValid() && path.value() != "/") {
        WatchSession(path);
        return;
      }
    }
    SourceStarted("logind", false, "the user has no graphical session");
  }

  void WatchSession(const dbus::ObjectPath& path) {
    session_path_ = path;
    session_watch_ = std::make_unique<SignalWatch>(
        system_bus_,
        std::vector<std::string>{
            SignalWatch::SignalRule(kLogind, path.value(), kLogindSession,
                                    "Lock"),
            SignalWatch::SignalRule(kLogind, path.value(), kProperties,
                                    "PropertiesChanged", kLogindSession)},
        std::set<SignalWatch::Member>{{kLogindSession, "Lock"},
                                      {kProperties, "PropertiesChanged"}},
        base::BindRepeating(&SystemSignals::SessionSignal,
                            weak_factory_.GetWeakPtr()),
        base::BindOnce(&SystemSignals::SourceStarted,
                       weak_factory_.GetWeakPtr(), "logind"));
  }

  void SessionSignal(dbus::Signal* signal) {
    if (signal->GetPath() != session_path_) {
      return;
    }
    if (signal->GetInterface() == kLogindSession &&
        signal->GetMember() == "Lock") {
      Locked("logind");
      return;
    }
    dbus::MessageReader reader(signal);
    std::string interface;
    dbus::MessageReader changed(nullptr);
    if (!reader.PopString(&interface) || interface != kLogindSession ||
        !reader.PopArray(&changed)) {
      return;
    }
    while (changed.HasMoreData()) {
      dbus::MessageReader entry(nullptr);
      std::string name;
      if (!changed.PopDictEntry(&entry) || !entry.PopString(&name)) {
        return;
      }
      bool locked = false;
      if (name == kLockedHint && entry.PopVariantOfBool(&locked)) {
        if (locked) {
          Locked("logind");
        }
        return;
      }
    }
    std::vector<std::string> invalidated;
    if (!reader.PopArrayOfStrings(&invalidated) ||
        !std::ranges::contains(invalidated, std::string(kLockedHint))) {
      return;
    }
    dbus::MethodCall call(kProperties, "Get");
    dbus::MessageWriter writer(&call);
    writer.AppendString(kLogindSession);
    writer.AppendString(kLockedHint);
    system_bus_->GetObjectProxy(kLogind, session_path_)
        ->CallMethod(&call, kCallTimeoutMs,
                     base::BindOnce(
                         [](base::WeakPtr<SystemSignals> self,
                            dbus::Response* response) {
                           bool locked = false;
                           if (self && response &&
                               dbus::MessageReader(response).PopVariantOfBool(
                                   &locked) &&
                               locked) {
                             self->Locked("logind");
                           }
                         },
                         weak_factory_.GetWeakPtr()));
  }

  void ScreenSaverSignal(dbus::Signal* signal) {
    bool active = false;
    if (dbus::MessageReader(signal).PopBool(&active) && active) {
      Locked("screenSaver");
    }
  }

  void SleepSignal(dbus::Signal* signal) {
    bool sleeping = false;
    if (dbus::MessageReader(signal).PopBool(&sleeping)) {
      SetAsleep(sleeping);
    }
  }

  void SourceStarted(std::string source, bool watching, std::string why) {
    if (watching) {
      sources_.push_back(source);
    } else {
      failures_.push_back(base::StrCat({source, ": ", why}));
    }
    if (--pending_sources_ > 0) {
      return;
    }
    if (sources_.empty()) {
      CountLinux("screen_lock_watch_unavailable");
    }
    std::string through = sources_.empty()
                              ? std::string("nothing")
                              : base::JoinString(sources_, " and ");
    std::string message =
        base::StrCat({"watching for the session lock through ", through});
    if (!failures_.empty()) {
      base::StrAppend(&message,
                      {" (", base::JoinString(failures_, "; "), ")"});
    }
    Note("screenLock", message);
  }

  bool started_ = false;
  bool asleep_ = false;
  int pending_sources_ = 0;
  scoped_refptr<dbus::Bus> session_bus_;
  scoped_refptr<dbus::Bus> system_bus_;
  dbus::ObjectPath session_path_;
  std::unique_ptr<SignalWatch> saver_watch_;
  std::unique_ptr<SignalWatch> sleep_watch_;
  std::unique_ptr<SignalWatch> session_watch_;
  std::vector<std::string> sources_;
  std::vector<std::string> failures_;
  std::vector<base::RepeatingClosure> leave_listeners_;
  std::vector<int> idle_thresholds_;
  std::map<int, bool> idle_now_;
  base::RepeatingTimer idle_timer_;
  base::WeakPtrFactory<SystemSignals> weak_factory_{this};
};

std::optional<int> BatteryPercent() {
  base::FileEnumerator supplies(base::FilePath("/sys/class/power_supply"),
                                false, base::FileEnumerator::DIRECTORIES |
                                           base::FileEnumerator::SHOW_SYM_LINKS);
  for (base::FilePath supply = supplies.Next(); !supply.empty();
       supply = supplies.Next()) {
    std::string type;
    if (!base::ReadFileToStringWithMaxSize(supply.Append("type"), &type,
                                           64) ||
        base::TrimWhitespaceASCII(type, base::TRIM_ALL) != "Battery") {
      continue;
    }
    std::string capacity;
    int percent = 0;
    if (base::ReadFileToStringWithMaxSize(supply.Append("capacity"),
                                          &capacity, 64) &&
        base::StringToInt(base::TrimWhitespaceASCII(capacity, base::TRIM_ALL),
                          &percent)) {
      return percent;
    }
    return std::nullopt;
  }
  return std::nullopt;
}

base::DictValue PowerState(std::optional<int> battery_percent) {
  const int64_t total =
      base::SysInfo::AmountOfTotalPhysicalMemory().InBytes();
  const int64_t available =
      base::SysInfo::AmountOfAvailablePhysicalMemory().InBytes();
  base::PowerMonitor* monitor = base::PowerMonitor::GetInstance();
  base::DictValue state;
  state.Set("onBattery", monitor->IsInitialized() && monitor->IsOnBatteryPower());
  state.Set("batteryPercent",
            battery_percent ? base::Value(*battery_percent) : base::Value());
  state.Set("batterySaver", false);
  state.Set("memoryLoad",
            total > 0 ? static_cast<int>((total - available) * 100 / total) : 0);
  state.Set("physicalMemory", static_cast<double>(total));
  return state;
}

std::optional<int> g_battery_percent;

base::DictValue MovedTo(const base::FilePath& destination) {
  base::DictValue moved;
  moved.Set("ok", true);
  moved.Set("path", destination.value());
  return moved;
}

base::DictValue MoveCompletedDownload(
    base::FilePath path,
    base::FilePath target,
    std::vector<base::FilePath> approved) {
  base::DictValue result;
  result.Set("ok", false);
  if (!std::ranges::contains(approved, target)) {
    result.Set("reason", "folderNotApproved");
    return result;
  }
  if (!base::PathExists(path)) {
    result.Set("reason", "missing");
    return result;
  }
  if (!base::DirectoryExists(target)) {
    result.Set("reason", "folderMissing");
    result.Set("stagedPath", path.value());
    return result;
  }
  base::FilePath destination = FreeNameIn(target, path.BaseName());
  if (base::Move(path, destination)) {
    return MovedTo(destination);
  }
  if (base::CopyFile(path, destination) && base::DeleteFile(path)) {
    return MovedTo(destination);
  }
  result.Set("reason", "moveFailed");
  result.Set("stagedPath", path.value());
  if (base::PathExists(destination)) {
    result.Set("strayPath", destination.value());
  }
  return result;
}

base::FilePath Resolved(const std::string& folder) {
  base::FilePath path(folder);
  return path.IsAbsolute() && !path.ReferencesParent()
             ? path.StripTrailingSeparators()
             : base::FilePath();
}

}

base::FilePath FreeNameIn(const base::FilePath& folder,
                          const base::FilePath& name) {
  base::FilePath candidate = folder.Append(name);
  const std::string extension = name.FinalExtension();
  const std::string stem = name.RemoveFinalExtension().value();
  for (int n = 1; base::PathExists(candidate); ++n) {
    candidate = folder.Append(base::StrCat(
        {stem, " (", base::NumberToString(n), ")", extension}));
  }
  return candidate;
}

void WhenOwnerLeaves(base::RepeatingClosure listener) {
  SystemSignals::Get().AddLeaveListener(std::move(listener));
}

void RegisterSystemSignalsModule(ModuleRegistry& registry) {
  SystemSignals::Get().Start();
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce(&BatteryPercent),
      base::BindOnce([](std::optional<int> percent) {
        g_battery_percent = percent;
      }));
  registry.Define(kModule)
      .Sync("holdsIncomingLinks", SyncOf([](const base::ListValue&) {
              return ModuleResult(
                  base::Value(SystemSignals::Get().hold_incoming_links));
            }))
      .Sync("powerState", SyncOf([](const base::ListValue&) {
              base::ThreadPool::PostTaskAndReplyWithResult(
                  FROM_HERE,
                  {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
                  base::BindOnce(&BatteryPercent),
                  base::BindOnce([](std::optional<int> percent) {
                    g_battery_percent = percent;
                  }));
              return ModuleResult(base::Value(PowerState(g_battery_percent)));
            }))
      .Async("watchIdle", AnswerOf([](const base::ListValue& args) {
               std::vector<int> thresholds;
               if (const base::ListValue* list = ListArg(args, 0)) {
                 for (const base::Value& value : *list) {
                   std::optional<double> number = value.GetIfDouble();
                   if (number && *number > 0 && *number < 1e9) {
                     thresholds.push_back(static_cast<int>(*number));
                   }
                 }
               }
               SystemSignals::Get().WatchIdle(std::move(thresholds));
               return ModuleResult(base::Value());
             }))
      .Async("setHoldIncomingLinks", AnswerOf([](const base::ListValue& args) {
               SystemSignals::Get().hold_incoming_links = BoolArg(args, 0);
               return ModuleResult(base::Value());
             }))
      .Async("setApprovedDownloadFolders",
             AnswerOf([](const base::ListValue& args) {
               std::vector<base::FilePath> folders;
               if (const base::ListValue* list = ListArg(args, 0)) {
                 for (const base::Value& value : *list) {
                   base::FilePath folder =
                       value.is_string() ? Resolved(value.GetString())
                                         : base::FilePath();
                   if (!folder.empty()) {
                     folders.push_back(std::move(folder));
                   }
                 }
               }
               SystemSignals::Get().approved_folders = std::move(folders);
               return ModuleResult(base::Value());
             }))
      .Async("moveCompletedDownload",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               base::ThreadPool::PostTaskAndReplyWithResult(
                   FROM_HERE,
                   {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
                   base::BindOnce(&MoveCompletedDownload,
                                  base::FilePath(StringArg(args, 0)),
                                  Resolved(StringArg(args, 1)),
                                  SystemSignals::Get().approved_folders),
                   base::BindOnce(
                       [](ModuleReply reply, base::DictValue result) {
                         std::move(reply).Run(base::Value(std::move(result)));
                       },
                       std::move(reply)));
             }))
      .Async("devPost", AnswerOf([](const base::ListValue& args) {
               if (!CurrentLaunchConfig().test_instance) {
                 return ModuleResult(base::Value(false));
               }
               const std::string name = StringArg(args, 0);
               if (name == "willSleep") {
                 SystemSignals::Get().SetAsleep(true);
               } else if (name == "didWake") {
                 SystemSignals::Get().SetAsleep(false);
               } else if (name == "screenLocked") {
                 SystemSignals::Get().Locked("test");
               } else {
                 return ModuleResult(base::Value(false));
               }
               return ModuleResult(base::Value(true));
             }));
}

}
