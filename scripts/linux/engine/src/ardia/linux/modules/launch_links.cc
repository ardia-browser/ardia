// Copyright 2026 Ardia. Apache-2.0.

#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_arguments.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/thread_pool.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLaunchLinks";

std::vector<std::string>& Texts() {
  static base::NoDestructor<std::vector<std::string>> texts;
  return *texts;
}

std::vector<std::string> ReadTexts(std::vector<std::string> arguments) {
  base::FilePath cwd;
  base::GetCurrentDirectory(&cwd);
  return LaunchArgumentTexts(arguments, cwd, [](const base::FilePath& path) {
    return base::PathExists(path);
  });
}

}

void RegisterLaunchLinksModule(ModuleRegistry& registry) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadTexts,
                     base::CommandLine::ForCurrentProcess()->GetArgs()),
      base::BindOnce(
          [](base::OnceClosure release, std::vector<std::string> texts) {
            if (!texts.empty()) {
              Note("launch", "launch links: " +
                                 base::NumberToString(texts.size()) +
                                 " argument(s) held until the app listens");
            }
            Texts() = std::move(texts);
            std::move(release).Run();
          },
          registry.HoldUiLoad()));
  registry.Define(kModule)
      .Sync("launchArguments", SyncOf([](const base::ListValue&) {
              base::ListValue arguments;
              for (const std::string& text : Texts()) {
                base::DictValue argument;
                argument.Set("text", text);
                arguments.Append(std::move(argument));
              }
              base::DictValue launch;
              launch.Set("arguments", std::move(arguments));
              return ModuleResult(base::Value(std::move(launch)));
            }))
      .Sync("listening", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(true));
            }));
}

}
