// Copyright 2026 Ardia. Apache-2.0.

#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/immediate_crash.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaDev";
constexpr char kPngDataPrefix[] = "data:image/png;base64,";

std::optional<ModuleResult> RefuseOutsideTests() {
  if (CurrentLaunchConfig().test_instance) {
    return std::nullopt;
  }
  return ModuleFailure("dev calls are for test instances",
                       "ERR_NOT_TEST_INSTANCE");
}

void SnapshotWindow(base::ListValue args, ModuleReply reply) {
  if (auto refused = RefuseOutsideTests()) {
    std::move(reply).Run(std::move(*refused));
    return;
  }
  AppWindow* window = AppWindows::Get().Find(StringArg(args, 0));
  const base::FilePath path(StringArg(args, 1));
  if (!window || path.empty() || !path.IsAbsolute()) {
    std::move(reply).Run(base::Value(false));
    return;
  }
  window->Snapshot(base::BindOnce(
      [](base::FilePath path, ModuleReply reply, base::Value picture) {
        const std::string* url =
            picture.is_dict() ? picture.GetDict().FindString("url") : nullptr;
        std::string png;
        if (!url || !base::StartsWith(*url, kPngDataPrefix) ||
            !base::Base64Decode(
                std::string_view(*url).substr(sizeof(kPngDataPrefix) - 1),
                &png)) {
          std::move(reply).Run(base::Value(false));
          return;
        }
        base::ThreadPool::PostTaskAndReplyWithResult(
            FROM_HERE, {base::MayBlock()},
            base::BindOnce(
                [](base::FilePath path, std::string png) {
                  return base::WriteFile(path, png);
                },
                path, std::move(png)),
            base::BindOnce(
                [](ModuleReply reply, bool written) {
                  std::move(reply).Run(base::Value(written));
                },
                std::move(reply)));
      },
      path, std::move(reply)));
}

}

void RegisterDevModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Async("devMenuCommand", AnswerOf([](const base::ListValue& args) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               base::DictValue payload;
               payload.Set("command", StringArg(args, 0));
               payload.Set("arg", OrNull(OptionalStringArg(args, 1)));
               payload.Set("windowId", base::Value());
               payload.Set("focusGeneration", base::Value());
               ModuleRegistry::Get().Emit("ArdiaMenus", "onCommand",
                                          base::Value(std::move(payload)));
               return ModuleResult(base::Value());
             }))
      .Async("devSnapshotWindow", base::BindRepeating(&SnapshotWindow))
      .Async("reloadUi", AnswerOf([](const base::ListValue&) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               Note("dev", "reloading the UI");
               ReloadUiHost();
               return ModuleResult(base::Value());
             }))
      .Async("devCrash", AnswerOf([](const base::ListValue&) {
               if (auto refused = RefuseOutsideTests()) {
                 return std::move(*refused);
               }
               base::ImmediateCrash();
             }));
}

}
