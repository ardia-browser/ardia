// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/document_store.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/callback_list.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaDocuments";

base::CallbackListSubscription& QuitFlush() {
  static base::NoDestructor<base::CallbackListSubscription> subscription;
  return *subscription;
}

DocumentStore::Settled ReplyWhenSettled(ModuleReply reply) {
  return base::BindOnce(
      [](ModuleReply reply, std::optional<std::string> error) {
        if (error) {
          std::move(reply).Run(ModuleFailure(*error));
          return;
        }
        std::move(reply).Run(base::Value());
      },
      std::move(reply));
}

ModuleResult ReadDocument(const base::ListValue& args) {
  auto read = Documents().Read(StringArg(args, 0));
  if (!read.has_value()) {
    return ModuleFailure(read.error(), "ERR_LINUX_DOCUMENTS");
  }
  return OrNull(std::move(read.value()));
}

}

DocumentStore& Documents() {
  static base::NoDestructor<DocumentStore> store(
      DataDirectory(),
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *store;
}

void RegisterDocumentsModule(ModuleRegistry& registry) {
  Documents().Load(registry.HoldUiLoad());
  QuitFlush() = chrome::AddClosingAllBrowsersCallback(
      base::BindRepeating([](bool closing) {
        if (closing) {
          Note("documents", "flushing documents for quit");
          Documents().Flush();
        }
      }));
  registry.Define(kModule)
      .Sync("readDocument", base::BindRepeating(&ReadDocument))
      .Sync("writeDocument", SyncOf([](const base::ListValue& args) {
              return ModuleResult(base::Value(
                  Documents().Write(StringArg(args, 0), StringArg(args, 1))));
            }))
      .Sync("removeDocument", SyncOf([](const base::ListValue& args) {
              return ModuleResult(
                  base::Value(Documents().Remove(StringArg(args, 0))));
            }))
      .Async("saveDocument",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               Documents().Write(StringArg(args, 0), StringArg(args, 1),
                                 ReplyWhenSettled(std::move(reply)));
             }))
      .Async("documentSaved",
             AsyncOf([](base::ListValue args, ModuleReply reply) {
               Documents().WhenSaved(StringArg(args, 0),
                                     ReplyWhenSettled(std::move(reply)));
             }));
}

}
