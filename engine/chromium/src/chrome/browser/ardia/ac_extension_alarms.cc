// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/ardia/ac_extension_mirror_internal.h"
#include "chrome/browser/profiles/profile.h"
#include "extensions/browser/api/alarms/alarm_manager.h"
#include "extensions/browser/api/alarms/alarms_api_constants.h"
#include "extensions/common/api/alarms.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest.h"
#include "extensions/common/mojom/api_permission_id.mojom-shared.h"

extern void (*g_ardia_extension_alarm_fired)(content::BrowserContext* context,
                                             const std::string& extension_id,
                                             const base::Value& alarm);

namespace ardia {
namespace {

namespace alarms = extensions::api::alarms;
using extensions::AlarmManager;

constexpr size_t kMaximumNameLength = 1024;

class AlarmsWatched : public mirror::Watched {
 public:
  using mirror::Watched::Watched;
};

void AlarmFired(content::BrowserContext* context,
                const std::string& extension_id,
                const base::Value& alarm) {
  if (!context || Profile::FromBrowserContext(context)->IsOffTheRecord() ||
      !mirror::IsWatched<AlarmsWatched>(context, extension_id)) {
    return;
  }
  Profile* profile = mirror::PrimaryProfile(context);
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<Profile> profile, std::string extension_id,
             base::Value alarm) {
            if (!profile) {
              return;
            }
            Emit("extensions.alarm", profile.get(),
                 base::DictValue()
                     .Set("id", extension_id)
                     .Set("alarm", std::move(alarm)));
          },
          profile->GetWeakPtr(), extension_id, alarm.Clone()));
}

void InstallHook() {
  if (!g_ardia_extension_alarm_fired) {
    g_ardia_extension_alarm_fired = &AlarmFired;
  }
}

bool SamePeriod(const extensions::Alarm* existing,
                const alarms::AlarmCreateInfo& info) {
  return existing && existing->js_alarm && info.period_in_minutes &&
         !info.when && !info.delay_in_minutes &&
         existing->js_alarm->period_in_minutes == info.period_in_minutes;
}

struct Alarms {
  scoped_refptr<const extensions::Extension> extension;
  AlarmManager* manager = nullptr;
};

std::optional<Alarms> AlarmsFor(Call& call, Reply& reply) {
  scoped_refptr<const extensions::Extension> extension = mirror::ExtensionFor(
      call, reply, extensions::mojom::APIPermissionID::kAlarms, "alarms");
  if (!extension) {
    return std::nullopt;
  }
  AlarmManager* manager = AlarmManager::Get(mirror::PrimaryProfile(call));
  if (!manager) {
    reply.Error("alarms aren't available");
    return std::nullopt;
  }
  return Alarms{std::move(extension), manager};
}

std::string CreateError(const alarms::AlarmCreateInfo& info) {
  if (info.delay_in_minutes && info.when) {
    return "Cannot set both when and delayInMinutes.";
  }
  if (!info.delay_in_minutes && !info.when && !info.period_in_minutes) {
    return "Must set at least one of when, delayInMinutes, or "
           "periodInMinutes.";
  }
  if (info.name->length() > kMaximumNameLength) {
    return base::StringPrintf(
        "Alarm name size is %zu bytes which exceeds the limit of %zu bytes.",
        info.name->length(), kMaximumNameLength);
  }
  return std::string();
}

}
}

AC_PROFILE_CALL(ac_extension_alarms_create, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  std::optional<ardia::Alarms> found = ardia::AlarmsFor(call, reply);
  if (!found) {
    return;
  }
  const base::DictValue* raw = call.args().FindDict("info");
  std::optional<ardia::alarms::AlarmCreateInfo> info =
      raw ? ardia::alarms::AlarmCreateInfo::FromValue(*raw) : std::nullopt;
  if (!info) {
    reply.Error("alarmInfo isn't valid");
    return;
  }
  const std::string name = call.String("name");
  if (info->name && !name.empty()) {
    reply.Error(
        "Cannot set alarm name in both separate argument and object form.");
    return;
  }
  info->name = info->name.value_or(name);
  const std::string error = ardia::CreateError(*info);
  if (!error.empty()) {
    reply.Error(error);
    return;
  }
  const std::string id = found->extension->id();
  const base::TimeDelta granularity =
      extensions::alarms_api_constants::GetMinimumDelay(
          extensions::Manifest::IsUnpackedLocation(
              found->extension->location()),
          found->extension->manifest_version());
  AlarmManager* manager = found->manager;
  manager->GetAlarm(
      id, *info->name,
      base::BindOnce(
          [](AlarmManager* manager, std::string id,
             ardia::alarms::AlarmCreateInfo info, base::TimeDelta granularity,
             ardia::Reply reply, extensions::Alarm* existing) {
            if (ardia::SamePeriod(existing, info)) {
              reply.Send(base::DictValue().Set("kept", true));
              return;
            }
            if (manager->GetCountForExtension(id) >=
                AlarmManager::kMaxAlarmsPerExtension) {
              reply.Error(base::StringPrintf(
                  "An extension cannot have more than %d active alarms.",
                  AlarmManager::kMaxAlarmsPerExtension));
              return;
            }
            extensions::Alarm alarm(info, granularity, base::Time::Now());
            manager->AddAlarm(
                id, std::move(alarm),
                base::BindOnce([](ardia::Reply reply) { reply.Ok(); },
                               std::move(reply)));
          },
          manager, id, std::move(*info), granularity, std::move(reply)));
}

AC_PROFILE_CALL(ac_extension_alarms_get, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  std::optional<ardia::Alarms> found = ardia::AlarmsFor(call, reply);
  if (!found) {
    return;
  }
  found->manager->GetAlarm(
      found->extension->id(), call.String("name"),
      base::BindOnce(
          [](ardia::Reply reply, extensions::Alarm* alarm) {
            base::DictValue result;
            if (alarm && alarm->js_alarm) {
              result.Set("alarm", alarm->js_alarm->ToValue());
            }
            reply.Send(std::move(result));
          },
          std::move(reply)));
}

AC_PROFILE_CALL(ac_extension_alarms_get_all, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  std::optional<ardia::Alarms> found = ardia::AlarmsFor(call, reply);
  if (!found) {
    return;
  }
  found->manager->GetAllAlarms(
      found->extension->id(),
      base::BindOnce(
          [](ardia::Reply reply,
             const extensions::AlarmManager::AlarmList* list) {
            base::ListValue alarms;
            if (list) {
              for (const extensions::Alarm& alarm : *list) {
                if (alarm.js_alarm) {
                  alarms.Append(alarm.js_alarm->ToValue());
                }
              }
            }
            reply.Send(base::DictValue().Set("alarms", std::move(alarms)));
          },
          std::move(reply)));
}

AC_PROFILE_CALL(ac_extension_alarms_clear, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  std::optional<ardia::Alarms> found = ardia::AlarmsFor(call, reply);
  if (!found) {
    return;
  }
  found->manager->RemoveAlarm(
      found->extension->id(), call.String("name"),
      base::BindOnce(
          [](ardia::Reply reply, bool removed) {
            reply.Send(base::DictValue().Set("removed", removed));
          },
          std::move(reply)));
}

AC_PROFILE_CALL(ac_extension_alarms_clear_all, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  std::optional<ardia::Alarms> found = ardia::AlarmsFor(call, reply);
  if (!found) {
    return;
  }
  found->manager->RemoveAllAlarms(
      found->extension->id(),
      base::BindOnce([](ardia::Reply reply) { reply.Ok(); }, std::move(reply)));
}

AC_PROFILE_CALL(ac_extension_alarms_watch, ardia::OffTheRecord::kAllow) {
  ardia::Reply reply = call.TakeReply();
  const std::string id = call.String("id");
  if (id.empty()) {
    reply.Error("id is missing");
    return;
  }
  ardia::InstallHook();
  ardia::StateFor<ardia::AlarmsWatched>(ardia::mirror::PrimaryProfile(call))
      .Set(id, call.Bool("on", true));
  reply.Ok();
}
