// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/page_channel/page_channel.h"

#include <utility>

#include "ardia/core/ac_page_limits.h"
#include "ardia/core/ac_page_script.h"
#include "ardia/linux/log.h"
#include "ardia/linux/main.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/bind_post_task.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/page.h"
#include "content/public/browser/permission_controller.h"
#include "content/public/browser/permission_descriptor_util.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/render_process_host_creation_observer.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/permissions/permission_utils.h"
#include "third_party/blink/public/mojom/permissions/permission_status.mojom.h"

namespace ardia_linux {

namespace {

constexpr char kPageScriptFile[] = "page_script.js";

bool MayShowNotification(content::RenderFrameHost& frame) {
  return frame.GetBrowserContext()
             ->GetPermissionController()
             ->GetPermissionStatusForCurrentDocument(
                 content::PermissionDescriptorUtil::
                     CreatePermissionDescriptorForPermissionType(
                         blink::PermissionType::NOTIFICATIONS),
                 &frame) == blink::mojom::PermissionStatus::GRANTED;
}

mojo::AssociatedRemote<ardiacore::mojom::ACPage> PageOf(
    content::RenderFrameHost* frame) {
  mojo::AssociatedRemote<ardiacore::mojom::ACPage> page;
  if (frame && frame->IsRenderFrameLive()) {
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&page);
  }
  return page;
}

base::FilePath PageScriptPath() {
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  base::FilePath ui_dir = command_line.GetSwitchValuePath(kUiDirSwitch);
  if (ui_dir.empty()) {
    base::PathService::Get(base::DIR_EXE, &ui_dir);
    ui_dir = ui_dir.Append("ui");
  }
  return ui_dir.AppendASCII(kPageScriptFile);
}

std::optional<std::string> ReadPageScript(base::FilePath path) {
  std::string script;
  if (!base::ReadFileToString(path, &script)) {
    return std::nullopt;
  }
  return script;
}

class PageScriptSender : public content::RenderProcessHostCreationObserver {
 public:
  void OnRenderProcessHostCreated(content::RenderProcessHost* host) override {
    if (!ardiacore::GetPageScript().empty()) {
      ardiacore::SendPageScript(host);
    }
  }
};

void PageScriptRead(std::optional<std::string> script) {
  if (!script || script->empty()) {
    Note("pages", "no page script beside the UI; pages run without it");
    return;
  }
  ardiacore::SetPageScript(*script);
  Note("pages", "page script loaded (" +
                    base::NumberToString(script->size()) + " bytes)");
}

}

void RegisterPageChannelBinders(content::RenderFrameHost& render_frame_host,
                                blink::AssociatedInterfaceRegistry& registry) {
  registry.AddInterface<ardiacore::mojom::ACPageHost>(base::BindRepeating(
      [](content::RenderFrameHost* frame,
         mojo::PendingAssociatedReceiver<ardiacore::mojom::ACPageHost>
             receiver) {
        if (content::WebContents* contents =
                content::WebContents::FromRenderFrameHost(frame)) {
          PageChannel::GetOrCreate(contents)->Bind(frame, std::move(receiver));
        }
      },
      &render_frame_host));
}

void StartPageScript() {
  static base::NoDestructor<PageScriptSender> sender;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadPageScript, PageScriptPath()),
      base::BindOnce(&PageScriptRead));
}

PageChannel::PageChannel(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<PageChannel>(*contents),
      receivers_(contents, this) {}

PageChannel::~PageChannel() = default;

PageChannel* PageChannel::GetOrCreate(content::WebContents* contents) {
  CreateForWebContents(contents);
  return FromWebContents(contents);
}

std::string PageChannel::FrameId(content::RenderFrameHost* frame) {
  const content::GlobalRenderFrameHostId id = frame->GetGlobalId();
  return base::StrCat({base::NumberToString(id.child_id.GetUnsafeValue()), ":",
                       base::NumberToString(id.frame_routing_id)});
}

void PageChannel::Bind(
    content::RenderFrameHost* frame,
    mojo::PendingAssociatedReceiver<ardiacore::mojom::ACPageHost> receiver) {
  receivers_.Bind(frame, std::move(receiver));
}

void PageChannel::Post(const std::string& kind, const std::string& json) {
  content::RenderFrameHost& frame = receivers_.CurrentTargetFrame();
  if (kind.size() > ardiacore::kMaxPageMessageKind ||
      json.size() > ardiacore::MaxPageMessageBytes(kind)) {
    return;
  }
  if (kind == "notification" && !MayShowNotification(frame)) {
    return;
  }
  HandlePageMessage(&GetWebContents(), frame, kind, json);
}

void PageChannel::PrimaryPageChanged(content::Page& page) {
  main_page_.reset();
  ResetPageReports(&GetWebContents(), false);
}

void PageChannel::WebContentsDestroyed() {
  ResetPageReports(&GetWebContents(), true);
}

void PageChannel::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  main_page_.reset();
}

ardiacore::mojom::ACPage* PageChannel::MainPage() {
  content::RenderFrameHost* frame = GetWebContents().GetPrimaryMainFrame();
  if (!frame->IsRenderFrameLive()) {
    return nullptr;
  }
  if (!main_page_.is_bound() || !main_page_.is_connected() ||
      main_page_frame_ != frame->GetGlobalId()) {
    main_page_.reset();
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&main_page_);
    main_page_frame_ = frame->GetGlobalId();
  }
  return main_page_.get();
}

content::RenderFrameHost* PageChannel::FindFrame(const std::string& frame_id) {
  content::RenderFrameHost* target = nullptr;
  GetWebContents().GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (!target && FrameId(frame) == frame_id) {
          target = frame;
        }
      });
  return target;
}

void PageChannel::CallPage(const std::string& kind, const std::string& json) {
  if (ardiacore::mojom::ACPage* page = MainPage()) {
    page->CallPage(kind, json);
  }
}

void PageChannel::CallFrame(const std::string& frame_id,
                            const std::string& kind,
                            const std::string& json) {
  if (frame_id.empty()) {
    CallPage(kind, json);
    return;
  }
  content::RenderFrameHost* target = FindFrame(frame_id);
  if (!target) {
    return;
  }
  if (target->IsInPrimaryMainFrame()) {
    CallPage(kind, json);
  } else if (auto page = PageOf(target)) {
    page->CallPage(kind, json);
  }
}

void PageChannel::Execute(const std::string& code) {
  if (ardiacore::mojom::ACPage* page = MainPage()) {
    page->Execute(code);
  }
}

void PageChannel::Evaluate(
    const std::string& code,
    base::OnceCallback<void(const std::optional<std::string>&)> callback) {
  auto answer = mojo::WrapCallbackWithDefaultInvokeIfNotRun(
      base::BindPostTaskToCurrentDefault(std::move(callback)), std::nullopt);
  ardiacore::mojom::ACPage* page = MainPage();
  if (!page) {
    std::move(answer).Run(std::nullopt);
    return;
  }
  page->Evaluate(code, std::move(answer));
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(PageChannel);

}
