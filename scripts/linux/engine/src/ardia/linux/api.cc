// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/api.h"

#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/host/host.h"
#include "ardia/linux/main.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/page_channel/page_channel.h"
#include "ardia/win/ac_calls.h"
#include "ardia/win/profiles.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "chrome/browser/ardia/ac_sensitive_args.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"

extern "C" void ac_engine_set_event_sink(ac_engine_event_t sink, void* context);

namespace ardia_win {

namespace {

std::string Json(const base::DictValue& dict) {
  return base::WriteJson(dict).value_or("{}");
}

using JsonReply = base::OnceCallback<void(std::string)>;

void DeliverEngineReply(void* context, const char* json) {
  std::unique_ptr<JsonReply> reply(static_cast<JsonReply*>(context));
  std::move(*reply).Run(json ? json : "{}");
}

void RunEngineCall(ac_engine_call_t call,
                   bool off_the_record,
                   ardia::Secret args,
                   JsonReply reply,
                   Profile* profile) {
  if (!profile) {
    std::move(reply).Run(Json(Error("profile not loaded")));
    return;
  }
  const std::string directory =
      profile->GetOriginalProfile()->GetPath().value();
  std::string marked = args.value();
  if (off_the_record) {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(args.value(), base::JSON_PARSE_RFC);
    if (!parsed || !parsed->is_dict()) {
      if (parsed) {
        ardia::Cleanse(*parsed);
      }
      ardia::Cleanse(marked);
      std::move(reply).Run(Json(Error("bad arguments")));
      return;
    }
    parsed->GetDict().Set("offTheRecord", true);
    ardia::Cleanse(marked);
    marked = Json(parsed->GetDict());
    ardia::Cleanse(*parsed);
  }
  call(directory.c_str(), marked.c_str(), &DeliverEngineReply,
       new JsonReply(std::move(reply)));
  ardia::Cleanse(marked);
}

void OnEngineEvent(void* context, const char* topic, const char* json) {
  std::optional<base::DictValue> payload =
      base::JSONReader::ReadDict(json ? json : "{}", base::JSON_PARSE_RFC);
  if (!payload) {
    return;
  }
  if (const std::string* directory = payload->FindString("profile")) {
    payload->Set("profile", NameOfProfilePath(base::FilePath(*directory)));
  }
  base::DictValue event;
  event.Set("topic", topic ? topic : "");
  event.Set("payload", std::move(*payload));
  Emit("engine", std::move(event));
}

void CallEngine(const std::string& name,
                const std::string& profile,
                std::string args,
                JsonReply reply) {
  ac_engine_call_t call = FindEngineCall(name);
  if (!call) {
    std::move(reply).Run(Json(Error("unknown call")));
    return;
  }
  WithProfile(profile, base::BindOnce(&RunEngineCall, call,
                                      ParseProfileName(profile).off_the_record,
                                      ardia::Secret(std::move(args)),
                                      std::move(reply)));
}

const ArdiaEngineApi kApi = {ARDIA_ENGINE_API_VERSION, sizeof(ArdiaEngineApi),
                             nullptr,                  nullptr,
                             nullptr,                  &ardia_linux::TestGateDecision};

}

const ArdiaEngineApi* EngineApi() {
  return &kApi;
}

void WatchEngineEvents() {
  ac_engine_set_event_sink(&OnEngineEvent, nullptr);
}

void Emit(std::string_view topic, base::DictValue payload) {
  if (!ardia_linux::ModuleRegistry::Exists()) {
    return;
  }
  if (topic == "tab") {
    ardia_linux::AmendTabEvent(payload);
  }
  base::DictValue event;
  event.Set("topic", topic);
  event.Set("json", Json(payload));
  ardia_linux::ModuleRegistry::Get().Emit(ardia_linux::kEngineHostModule,
                                          "event",
                                          base::Value(std::move(event)));
}

base::DictValue Error(std::string_view message) {
  base::DictValue result;
  result.Set("error", message);
  return result;
}


}

namespace ardia_linux {

namespace {

std::string StringAt(const base::ListValue& args, size_t index) {
  if (index >= args.size()) {
    return std::string();
  }
  const std::string* value = args[index].GetIfString();
  return value ? *value : std::string();
}

ModuleResult Text(std::string json) {
  return base::Value(std::move(json));
}

void HostCall(base::ListValue args, ModuleReply reply) {
  const std::string verb = StringAt(args, 0);
  const std::string json = StringAt(args, 1);
  const std::string window = StringAt(args, 2);
  std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(
      json.empty() ? "{}" : json, base::JSON_PARSE_RFC);
  if (!parsed) {
    std::move(reply).Run(Text(base::WriteJson(ardia_win::Error(
                                                  "bad arguments"))
                                  .value_or("{}")));
    return;
  }
  Host::Get()->Call(verb, std::move(*parsed), window,
                    base::BindOnce(
                        [](ModuleReply reply, base::DictValue result) {
                          std::move(reply).Run(Text(
                              base::WriteJson(result).value_or("{}")));
                        },
                        std::move(reply)));
}

void EngineCall(base::ListValue args, ModuleReply reply) {
  std::string json = StringAt(args, 2);
  ardia_win::CallEngine(
      StringAt(args, 0), StringAt(args, 1), json.empty() ? "{}" : json,
      base::BindOnce(
          [](ModuleReply reply, std::string answer) {
            std::move(reply).Run(Text(std::move(answer)));
          },
          std::move(reply)));
  ardia::Cleanse(json);
  for (base::Value& value : args) {
    ardia::Cleanse(value);
  }
}

}

void RegisterEngineHostModule(ModuleRegistry& registry) {
  registry.Define(kEngineHostModule)
      .Sync("available",
            base::BindRepeating([](const base::ListValue&) -> ModuleResult {
              return base::Value(true);
            }))
      .Sync("profileDataFolder",
            base::BindRepeating([](const base::ListValue&) -> ModuleResult {
              return base::Value(
                  g_browser_process->profile_manager()->user_data_dir().value());
            }))
      .Async("hostCall", base::BindRepeating(&HostCall))
      .Async("engineCall", base::BindRepeating(&EngineCall));
}

}
