// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/host/extension_views.h"

#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/extensions/extension_view.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "extensions/browser/extension_host_registry.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_registry_observer.h"
#include "extensions/browser/extension_util.h"
#include "extensions/common/constants.h"
#include "extensions/common/extension.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr gfx::Size kPopupMinimumSize(25, 25);
constexpr gfx::Size kPopupMaximumSize(800, 600);
constexpr base::TimeDelta kPopupWait = base::Seconds(10);

class HostedView;

std::map<content::WebContents*, std::unique_ptr<HostedView>>& Views() {
  static base::NoDestructor<
      std::map<content::WebContents*, std::unique_ptr<HostedView>>>
      views;
  return *views;
}

void Destroy(content::WebContents* contents);

class HostedView : public extensions::ExtensionView,
                   public content::WebContentsObserver,
                   public BrowserCollectionObserver,
                   public extensions::ExtensionRegistryObserver,
                   public extensions::ExtensionHostRegistry::Observer,
                   public ProfileObserver {
 public:
  HostedView(std::unique_ptr<extensions::ExtensionViewHost> host,
             Browser* browser,
             ExtensionViewKind kind)
      : host_(std::move(host)), browser_(browser), kind_(kind) {
    host_->set_view(this);
    Observe(host_->host_contents());
    host_->SetCloseHandler(base::BindOnce(&HostedView::ClosedByChrome,
                                          weak_factory_.GetWeakPtr()));
    browser_observation_.Observe(GlobalBrowserCollection::GetInstance());
    content::BrowserContext* context = host_->browser_context();
    registry_observation_.Observe(extensions::ExtensionRegistry::Get(context));
    hosts_observation_.Observe(extensions::ExtensionHostRegistry::Get(context));
    profile_observation_.Observe(Profile::FromBrowserContext(context));
  }
  HostedView(const HostedView&) = delete;
  HostedView& operator=(const HostedView&) = delete;
  ~HostedView() override {
    Observe(nullptr);
    FailShown();
  }

  content::WebContents* contents() const { return host_->host_contents(); }
  ExtensionViewKind kind() const { return kind_; }
  const std::string& extension_id() const { return host_->extension_id(); }
  const gfx::Size& preferred_size() const { return preferred_size_; }

  void set_shown_callback(ShowPopupCallback callback) {
    FailShown();
    shown_callback_ = std::move(callback);
    if (host_->has_loaded_once()) {
      OnLoaded();
    }
  }

  void Start() { host_->CreateRendererSoon(); }

  void ScheduleDestroy() {
    if (destroy_scheduled_) {
      return;
    }
    destroy_scheduled_ = true;
    FailShown();
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<HostedView> view) {
                         if (view) {
                           Destroy(view->contents());
                         }
                       },
                       weak_factory_.GetWeakPtr()));
  }

  void ReportClosed() {
    ardia_win::TabState* state =
        ardia_win::TabState::FromWebContents(contents());
    if (state && !state->key().empty() && !state->closed_by_host()) {
      state->set_closed_by_host();
      state->Send("windowClose", base::DictValue());
    }
  }

  gfx::NativeView GetNativeView() override {
    return contents()->GetNativeView();
  }

  void ResizeDueToAutoResize(content::WebContents* web_contents,
                             const gfx::Size& new_size) override {
    if (kind_ != ExtensionViewKind::kPopup || new_size == preferred_size_) {
      return;
    }
    preferred_size_ = new_size;
    ardia_win::TabState* state =
        ardia_win::TabState::FromWebContents(contents());
    if (state && !state->key().empty()) {
      base::DictValue size;
      size.Set("width", new_size.width());
      size.Set("height", new_size.height());
      state->Send("preferredSize", std::move(size));
    }
  }

  void RenderFrameCreated(
      content::RenderFrameHost* render_frame_host) override {
    if (render_frame_host == contents()->GetPrimaryMainFrame()) {
      EnableAutoResize(render_frame_host);
    }
  }

  bool HandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    return browser_ && BrowserWebContentsDelegate::From(browser_)
                           ->HandleKeyboardEvent(source, event);
  }

  void OnLoaded() override {
    if (!shown_callback_) {
      return;
    }
    const bool shown = host_->document_element_available();
    if (!shown) {
      Note("extensions", "action.openPopup for " + extension_id() +
                             ": its page stopped loading without a document");
    }
    std::move(shown_callback_).Run(shown ? host_.get() : nullptr);
  }

  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override {
    if (old_host && new_host == contents()->GetPrimaryMainFrame() &&
        new_host->IsRenderFrameLive()) {
      EnableAutoResize(new_host);
    }
  }

  void OnBrowserClosed(BrowserWindowInterface* browser) override {
    if (browser != browser_) {
      return;
    }
    browser_ = nullptr;
    CloseNow();
  }

  void OnExtensionUnloaded(
      content::BrowserContext* browser_context,
      const extensions::Extension* extension,
      extensions::UnloadedExtensionReason reason) override {
    if (extension->id() == host_->extension_id()) {
      CloseNow();
    }
  }

  void OnExtensionHostRenderProcessGone(
      content::BrowserContext* browser_context,
      extensions::ExtensionHost* extension_host) override {
    if (extension_host == host_.get()) {
      ReportClosed();
      ScheduleDestroy();
    }
  }

  void OnProfileWillBeDestroyed(Profile* profile) override { CloseNow(); }

 private:
  void EnableAutoResize(content::RenderFrameHost* frame) {
    if (kind_ != ExtensionViewKind::kPopup || !frame->GetView()) {
      return;
    }
    frame->GetView()->EnableAutoResize(kPopupMinimumSize, kPopupMaximumSize);
  }

  void FailShown() {
    if (shown_callback_) {
      Note("extensions", "action.openPopup for " + extension_id() +
                             ": the popup closed before its page loaded");
      std::move(shown_callback_).Run(nullptr);
    }
  }

  void ClosedByChrome(extensions::ExtensionHost* host) {
    ReportClosed();
    ScheduleDestroy();
  }

  void CloseNow() {
    ReportClosed();
    Destroy(contents());
  }

  std::unique_ptr<extensions::ExtensionViewHost> host_;
  raw_ptr<Browser> browser_;
  const ExtensionViewKind kind_;
  gfx::Size preferred_size_;
  ShowPopupCallback shown_callback_;
  bool destroy_scheduled_ = false;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      browser_observation_{this};
  base::ScopedObservation<extensions::ExtensionRegistry,
                          extensions::ExtensionRegistryObserver>
      registry_observation_{this};
  base::ScopedObservation<extensions::ExtensionHostRegistry,
                          extensions::ExtensionHostRegistry::Observer>
      hosts_observation_{this};
  base::ScopedObservation<Profile, ProfileObserver> profile_observation_{this};
  base::WeakPtrFactory<HostedView> weak_factory_{this};
};

void Destroy(content::WebContents* contents) {
  auto found = Views().find(contents);
  if (found == Views().end()) {
    return;
  }
  std::unique_ptr<HostedView> view = std::move(found->second);
  Views().erase(found);
}

class PendingPopup : public BrowserCollectionObserver {
 public:
  PendingPopup(BrowserWindowInterface* browser,
               std::string extension_id,
               ShowPopupCallback callback);
  PendingPopup(const PendingPopup&) = delete;
  PendingPopup& operator=(const PendingPopup&) = delete;
  ~PendingPopup() override = default;

  bool Matches(const BrowserWindowInterface* browser,
               const std::string& extension_id) const {
    return browser == browser_ && extension_id == extension_id_;
  }
  const std::string& extension_id() const { return extension_id_; }
  ShowPopupCallback TakeCallback() { return std::move(callback_); }

  void OnBrowserClosed(BrowserWindowInterface* browser) override;

 private:
  const void* browser_;
  const std::string extension_id_;
  ShowPopupCallback callback_;
  base::OneShotTimer timeout_;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      observation_{this};
  base::WeakPtrFactory<PendingPopup> weak_factory_{this};
};

std::unique_ptr<PendingPopup>& Pending() {
  static base::NoDestructor<std::unique_ptr<PendingPopup>> pending;
  return *pending;
}

void FailPending(const char* why) {
  std::unique_ptr<PendingPopup> pending = std::move(Pending());
  if (!pending) {
    return;
  }
  Note("extensions",
       "action.openPopup for " + pending->extension_id() + ": " + why);
  ShowPopupCallback callback = pending->TakeCallback();
  pending.reset();
  if (callback) {
    std::move(callback).Run(nullptr);
  }
}

PendingPopup::PendingPopup(BrowserWindowInterface* browser,
                           std::string extension_id,
                           ShowPopupCallback callback)
    : browser_(browser),
      extension_id_(std::move(extension_id)),
      callback_(std::move(callback)) {
  observation_.Observe(GlobalBrowserCollection::GetInstance());
  timeout_.Start(FROM_HERE, kPopupWait,
                 base::BindOnce(&FailPending,
                                "no popup of the extension opened in its "
                                "window within 10 s"));
}

void PendingPopup::OnBrowserClosed(BrowserWindowInterface* browser) {
  if (browser != browser_) {
    return;
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<PendingPopup> pending) {
                       if (pending && Pending().get() == pending.get()) {
                         FailPending("its window closed");
                       }
                     },
                     weak_factory_.GetWeakPtr()));
}

}

std::optional<ExtensionViewKind> ExtensionViewKindNamed(std::string_view name) {
  if (name == "popup") {
    return ExtensionViewKind::kPopup;
  }
  if (name == "sidePanel") {
    return ExtensionViewKind::kSidePanel;
  }
  return std::nullopt;
}

content::WebContents* OpenExtensionView(Browser* browser,
                                        const GURL& url,
                                        ExtensionViewKind kind) {
  if (!browser || !url.SchemeIs(extensions::kExtensionScheme)) {
    return nullptr;
  }
  Profile* profile = browser->GetProfile();
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
          std::string(url.host()));
  if (!extension ||
      (profile->IsOffTheRecord() &&
       !extensions::util::IsIncognitoEnabled(extension->id(), profile))) {
    return nullptr;
  }
  std::unique_ptr<extensions::ExtensionViewHost> host =
      kind == ExtensionViewKind::kPopup
          ? extensions::ExtensionViewHostFactory::CreatePopupHost(*extension,
                                                                  url, browser)
          : extensions::ExtensionViewHostFactory::CreateSidePanelHost(
                *extension, url, browser, nullptr);
  if (!host) {
    return nullptr;
  }
  auto view = std::make_unique<HostedView>(std::move(host), browser, kind);
  HostedView* hosted = view.get();
  content::WebContents* contents = hosted->contents();
  Views()[contents] = std::move(view);
  CountLinux(kind == ExtensionViewKind::kPopup ? "extensionPopupsOpened"
                                               : "extensionSidePanelsOpened");
  if (kind == ExtensionViewKind::kPopup && Pending()) {
    if (Pending()->Matches(browser, extension->id())) {
      ShowPopupCallback callback = Pending()->TakeCallback();
      Pending().reset();
      hosted->set_shown_callback(std::move(callback));
    } else {
      Note("extensions", "action.openPopup for " + Pending()->extension_id() +
                             ": a popup of " + extension->id() +
                             " opened meanwhile, in another window or profile");
    }
  }
  hosted->Start();
  return contents;
}

bool IsExtensionView(content::WebContents* contents) {
  return contents && Views().contains(contents);
}

bool CloseExtensionView(content::WebContents* contents) {
  auto found = Views().find(contents);
  if (found == Views().end()) {
    return false;
  }
  if (ardia_win::TabState* state =
          ardia_win::TabState::FromWebContents(contents)) {
    state->set_closed_by_host();
  }
  found->second->ScheduleDestroy();
  return true;
}

void CloseAllExtensionViews() {
  FailPending("the engine is shutting down");
  std::vector<std::unique_ptr<HostedView>> views;
  for (auto& [contents, view] : Views()) {
    views.push_back(std::move(view));
  }
  Views().clear();
  for (const auto& view : views) {
    view->ReportClosed();
  }
}

gfx::Size ExtensionPopupPreferredSize(content::WebContents* contents) {
  auto found = Views().find(contents);
  return found != Views().end() &&
                 found->second->kind() == ExtensionViewKind::kPopup
             ? found->second->preferred_size()
             : gfx::Size();
}

void ExpectActionPopup(BrowserWindowInterface* browser,
                       std::string extension_id,
                       ShowPopupCallback callback) {
  FailPending("another openPopup came first");
  Pending() = std::make_unique<PendingPopup>(browser, std::move(extension_id),
                                             std::move(callback));
}

}
