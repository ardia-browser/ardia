// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/leaving_pages.h"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/host/host.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "net/base/url_util.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLinuxPages";
constexpr base::TimeDelta kProbeDeadline = base::Seconds(2);

class StayProbe : public content::WebContentsObserver {
 public:
  StayProbe(content::WebContents* contents,
            base::OnceCallback<void(bool)> answered)
      : content::WebContentsObserver(contents),
        answered_(std::move(answered)) {}

  void Start() {
    deadline_.Start(FROM_HERE, kProbeDeadline,
                    base::BindOnce(&StayProbe::Answer, base::Unretained(this),
                                   false));
    web_contents()->DispatchBeforeUnload(true);
  }

  void BeforeUnloadFired(bool proceed) override { Answer(!proceed); }
  void WebContentsDestroyed() override { Answer(false); }

 private:
  void Answer(bool wants_to_stay) {
    deadline_.Stop();
    if (answered_) {
      std::move(answered_).Run(wants_to_stay);
    }
  }

  base::OnceCallback<void(bool)> answered_;
  base::OneShotTimer deadline_;
};

class WindowCloseAsk {
 public:
  static void Start(std::string window_id,
                    const std::vector<content::WebContents*>& pages,
                    ModuleReply reply) {
    auto* ask = new WindowCloseAsk(std::move(window_id), std::move(reply));
    ask->Probe(pages);
  }

 private:
  WindowCloseAsk(std::string window_id, ModuleReply reply)
      : window_id_(std::move(window_id)), reply_(std::move(reply)) {}

  void Probe(const std::vector<content::WebContents*>& pages) {
    for (content::WebContents* page : pages) {
      const std::string site =
          net::GetHostAndOptionalPort(page->GetLastCommittedURL());
      probes_.push_back(std::make_unique<StayProbe>(
          page, base::BindOnce(&WindowCloseAsk::Probed,
                               weak_factory_.GetWeakPtr(), site)));
    }
    waiting_ = probes_.size();
    if (!waiting_) {
      Finish(true);
      return;
    }
    for (const std::unique_ptr<StayProbe>& probe : probes_) {
      probe->Start();
    }
  }

  void Probed(std::string site, bool wants_to_stay) {
    if (wants_to_stay && std::ranges::find(sites_, site) == sites_.end()) {
      sites_.push_back(site);
    }
    if (--waiting_) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&WindowCloseAsk::Ask, weak_factory_.GetWeakPtr()));
  }

  void Ask() {
    probes_.clear();
    if (sites_.empty()) {
      Finish(true);
      return;
    }
    CountLinux("window_close_unsaved_asked");
    const bool one = sites_.size() == 1;
    base::DictValue options;
    options.Set("title", one ? "Leave " + sites_.front() + "?"
                             : std::string("Leave these sites?"));
    options.Set("message",
                one ? "Changes you made on " + sites_.front() +
                          " may not be saved."
                    : "Changes you made on " +
                          base::NumberToString(sites_.size()) +
                          " sites may not be saved.");
    options.Set("confirmTitle", "Close Window");
    options.Set("cancelTitle", "Cancel");
    options.Set("windowId", window_id_);
    ConfirmWithUser(options,
                    base::BindOnce(&WindowCloseAsk::Answered,
                                   weak_factory_.GetWeakPtr()));
  }

  void Answered(bool confirmed, bool suppressed) {
    if (!confirmed) {
      CountLinux("window_close_unsaved_stayed");
    }
    Finish(confirmed);
  }

  void Finish(bool may_close) {
    std::move(reply_).Run(base::Value(may_close));
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                               this);
  }

  std::string window_id_;
  ModuleReply reply_;
  std::vector<std::unique_ptr<StayProbe>> probes_;
  std::vector<std::string> sites_;
  size_t waiting_ = 0;
  base::WeakPtrFactory<WindowCloseAsk> weak_factory_{this};
};

std::vector<content::WebContents*> PagesThatMayAsk(const base::Value* keys) {
  std::vector<content::WebContents*> pages;
  if (!keys || !keys->is_list()) {
    return pages;
  }
  for (const base::Value& key : keys->GetList()) {
    const std::string* text = key.GetIfString();
    content::WebContents* contents = text ? Host::Get()->FindTab(*text) : nullptr;
    if (contents && contents->NeedToFireBeforeUnload() &&
        std::ranges::find(pages, contents) == pages.end()) {
      pages.push_back(contents);
    }
  }
  return pages;
}

}

void RegisterLeavingPagesModule(ModuleRegistry& registry) {
  registry.Define(kModule).Async(
      "mayCloseWindow",
      base::BindRepeating([](base::ListValue args, ModuleReply reply) {
        const std::string* window_id =
            args.size() > 0 ? args[0].GetIfString() : nullptr;
        WindowCloseAsk::Start(window_id ? *window_id : std::string(),
                              PagesThatMayAsk(args.size() > 1 ? &args[1]
                                                              : nullptr),
                              std::move(reply));
      }));
}

}
