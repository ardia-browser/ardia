// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/file_drop.h"

#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/file_drop_rules.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/ui/views/tab_contents/chrome_web_contents_view_delegate_views.h"
#include "content/public/browser/site_instance.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/drop_data.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLinuxFileDrop";

std::vector<DroppedPath>& LastDrop() {
  static base::NoDestructor<std::vector<DroppedPath>> last_drop;
  return *last_drop;
}

std::vector<DroppedPath> ExamineDrop(std::vector<base::FilePath> paths) {
  std::vector<DroppedPath> examined;
  for (const base::FilePath& path : paths) {
    examined.push_back(ExamineDroppedPath(path));
  }
  return examined;
}

class AppUiViewDelegate : public ChromeWebContentsViewDelegateViews {
 public:
  using ChromeWebContentsViewDelegateViews::ChromeWebContentsViewDelegateViews;

  void OnPerformingDrop(const content::DropData& drop_data,
                        DropCompletionCallback callback) override {
    std::vector<base::FilePath> paths;
    for (const ui::FileInfo& file : drop_data.filenames) {
      if (paths.size() >= kMaxDroppedItems * 2) {
        break;
      }
      paths.push_back(file.path);
    }
    if (paths.empty()) {
      std::move(callback).Run(drop_data);
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
        base::BindOnce(&ExamineDrop, std::move(paths)),
        base::BindOnce(
            [](content::DropData drop_data, DropCompletionCallback callback,
               std::vector<DroppedPath> examined) {
              LastDrop() = std::move(examined);
              std::move(callback).Run(std::move(drop_data));
            },
            drop_data, std::move(callback)));
  }
};

const DroppedPath* FromLastDrop(const std::string& asked,
                                std::vector<bool>& taken) {
  std::vector<DroppedPath>& drop = LastDrop();
  for (size_t i = 0; i < drop.size(); ++i) {
    if (!taken[i] && drop[i].path.value() == asked) {
      taken[i] = true;
      return &drop[i];
    }
  }
  for (size_t i = 0; i < drop.size(); ++i) {
    if (!taken[i] && drop[i].path.BaseName().value() == asked) {
      taken[i] = true;
      return &drop[i];
    }
  }
  return nullptr;
}

}

bool IsAppUiContents(content::WebContents* web_contents) {
  content::WebContents* host = UiHostContents();
  if (!host || !web_contents || web_contents == host) {
    return false;
  }
  content::SiteInstance* site = web_contents->GetSiteInstance();
  return site && site->IsRelatedSiteInstance(host->GetSiteInstance());
}

std::unique_ptr<content::WebContentsViewDelegate> CreateAppUiViewDelegate(
    content::WebContents* web_contents) {
  return std::make_unique<AppUiViewDelegate>(web_contents);
}

void RegisterFileDropModule(ModuleRegistry& registry) {
  registry.Define(kModule).Sync(
      "droppedFiles", SyncOf([](const base::ListValue& args) {
        std::vector<const DroppedPath*> paths;
        std::vector<bool> taken(LastDrop().size(), false);
        if (const base::ListValue* asked = ListArg(args, 0)) {
          for (const base::Value& value : *asked) {
            if (!value.is_string()) {
              continue;
            }
            if (const DroppedPath* path =
                    FromLastDrop(value.GetString(), taken)) {
              paths.push_back(path);
            }
          }
        }
        return ModuleResult(base::Value(
            DroppedItems(paths, DropAcceptsFrom(StringArg(args, 1)))));
      }));
}

}
