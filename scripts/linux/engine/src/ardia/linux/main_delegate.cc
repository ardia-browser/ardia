// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/main_delegate.h"

#include <memory>
#include <string>
#include <string_view>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_hooks.h"
#include "ardia/linux/browser_window/web_contents_delegate.h"
#include "ardia/linux/content_browser_client.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/renderer/content_renderer_client.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/no_destructor.h"
#include "chrome/common/profiler/main_thread_stack_sampling_profiler.h"
#include "content/public/common/content_switches.h"

namespace ardia_linux {

namespace {

void MergeFeatures(base::CommandLine* command_line,
                   const char* list,
                   std::string_view features) {
  const std::string current = command_line->GetSwitchValueASCII(list);
  command_line->RemoveSwitch(list);
  command_line->AppendSwitchASCII(
      list, current.empty() ? std::string(features)
                            : current + "," + std::string(features));
}

bool BrowserProcess() {
  return base::CommandLine::ForCurrentProcess()
      ->GetSwitchValueASCII(switches::kProcessType)
      .empty();
}

BrowserWindow* WindowForChromeBrowser(Browser* browser) {
  return Host::Get()->HostChromeBrowser(browser);
}

bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) {
  return Host::Get()->Keeps(browser);
}

void InstallChromeHooks() {
  g_ardia_viewless_browsers = true;
  g_ardia_browser_window_factory = &WindowForChromeBrowser;
  g_ardia_create_web_contents_delegate = &CreateWebContentsDelegate;
  g_ardia_keeps_window_without_tabs = &KeepsWindowWithoutTabs;
  g_ardia_script_loader_ready_at_once = true;
  g_ardia_scripts_wait_at_response = true;
  g_ardia_skip_cpu_health_sampling = true;
  g_ardia_lazy_storage_usage = true;
  g_ardia_hybrid_scan_on_demand = true;
}

}

MainDelegate::MainDelegate(const StartupTimestamps& timestamps)
    : ChromeMainDelegate(timestamps) {}

MainDelegate::~MainDelegate() = default;

std::optional<int> MainDelegate::BasicStartupComplete() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  MergeFeatures(command_line, switches::kDisableFeatures,
                "Glic,GlicActor,GlicActorUi,ApiGlicPrivate,ContextualCueing,"
                "GlicZeroStateSuggestions");
  if (BrowserProcess()) {
    MergeFeatures(command_line, switches::kEnableFeatures,
                  "WebContentsDiscard");
  }
  return ChromeMainDelegate::BasicStartupComplete();
}

void MainDelegate::PreSandboxStartup() {
  if (BrowserProcess()) {
    InstallChromeHooks();
  }
  ChromeMainDelegate::PreSandboxStartup();
}

content::ContentBrowserClient* MainDelegate::CreateContentBrowserClient() {
  chrome_content_browser_client_ = std::make_unique<ContentBrowserClient>();
  if (sampling_profiler_) {
    chrome_content_browser_client_->SetSamplingProfiler(
        std::move(sampling_profiler_));
  }
  return chrome_content_browser_client_.get();
}

content::ContentRendererClient* MainDelegate::CreateContentRendererClient() {
  static base::NoDestructor<ContentRendererClient> client;
  return client.get();
}

}
