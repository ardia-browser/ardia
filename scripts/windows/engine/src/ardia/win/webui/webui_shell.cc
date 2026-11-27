#include "ardia/win/webui/webui_shell.h"

#include <windows.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/core/ac_hooks.h"
#include "ardia/desktop/ac_desktop_webui_process_policy.h"
#include "ardia/win/hooks.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/main.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_bridge.h"
#include "ardia/win/webui/webui_frame.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_host_view.h"
#include "ardia/win/webui/webui_mode.h"
#include "ardia/win/webui/webui_policy.h"
#include "ardia/win/webui/webui_storage.h"
#include "ardia/win/webui/webui_windows.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"
#include "content/public/browser/webui_config_map.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/native_ui_types.h"
#include "url/gurl.h"

extern BrowserWindowInterface* (*g_ardia_linux_companion_owner)(
    const BrowserWindowInterface*);
extern bool (*g_ardia_linux_present_companion)(BrowserWindowInterface*,
                                               bool activate);
extern bool (*g_ardia_linux_is_companion)(const BrowserWindowInterface*);
extern int (*g_ardia_linux_window_tab_count)(const BrowserWindowInterface*);
extern bool (*g_ardia_linux_shell_passes_point)(gfx::NativeView child,
                                                const gfx::Point& location);
extern bool (*g_ardia_linux_off_the_record_navigation)(
    content::WebContents* source,
    const GURL& url);

namespace ardia_win {

namespace {

using webui::WindowRegistry;

void RefuseMissingBundle() {
  const std::string folder = webui::AssetDirectory().AsUTF8Unsafe();
  LOG(ERROR) << "Ardia WebUI shell: the shell UI could not load from "
             << folder << "; quitting";
  NoteForTest("webui shell: the shell UI could not load from " + folder +
              "; quitting");
  const DWORD background =
      ::GetEnvironmentVariableW(L"ARDIA_BACKGROUND", nullptr, 0);
  if (background == 0) {
    const std::wstring text = L"Ardia couldn't start: the browser UI is "
                              L"missing from " +
                              base::UTF8ToWide(folder) +
                              L".\n\nInstalling Ardia again usually fixes "
                              L"this.";
    ::MessageBoxW(nullptr, text.c_str(), L"Ardia",
                  MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
  }
  MarkStartSettled();
  QuitApp();
}

class ShellDataSource : public content::URLDataSource {
 public:
  std::string GetSource() override { return "ardia"; }
  bool AllowCaching() override { return false; }
  bool ShouldServeMimeTypeAsContentTypeHeader() override { return true; }
  std::string GetMimeType(const GURL& url) override {
    return webui::MimeType(webui::AssetPath(url));
  }
  std::string GetContentSecurityPolicy(
      network::mojom::CSPDirectiveName directive) override {
    using Directive = network::mojom::CSPDirectiveName;
    switch (directive) {
      case Directive::DefaultSrc:
        return "default-src 'none';";
      case Directive::ScriptSrc:
        return "script-src 'self';";
      case Directive::TrustedTypes:
        return "trusted-types ardia-symbols;";
      case Directive::StyleSrc:
        return "style-src 'self' 'unsafe-inline';";
      case Directive::ImgSrc:
        return "img-src 'self' data: blob:;";
      case Directive::FontSrc:
        return "font-src 'self' data:;";
      case Directive::MediaSrc:
        return "media-src 'self';";
      case Directive::ConnectSrc:
        return "connect-src 'none';";
      case Directive::FrameSrc:
        return "frame-src 'none';";
      case Directive::ChildSrc:
        return "child-src 'none';";
      case Directive::ObjectSrc:
        return "object-src 'none';";
      case Directive::BaseURI:
        return "base-uri 'none';";
      case Directive::FormAction:
        return "form-action 'none';";
      default:
        return content::URLDataSource::GetContentSecurityPolicy(directive);
    }
  }
  void StartDataRequest(const GURL& url,
                        const content::WebContents::Getter& getter,
                        GotDataCallback callback) override {
    CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    content::WebContents* contents = getter.Run();
    webui::ShellHostView* host = WindowRegistry::Get().HostForShell(contents);
    if (!host || url.scheme() != "chrome" || url.host() != "ardia") {
      return std::move(callback).Run(nullptr);
    }
    const std::string path = webui::AssetPath(url);
    webui::FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&webui::ReadAsset, webui::AssetDirectory(), path,
                       host->BootstrapJson(), webui::SessionDirectory()),
        base::BindOnce(
            [](GotDataCallback callback, bool entry,
               std::optional<std::string> contents) {
              if (!contents && entry) {
                base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
                    FROM_HERE, base::BindOnce(&RefuseMissingBundle));
              }
              std::move(callback).Run(
                  contents ? base::MakeRefCounted<base::RefCountedString>(
                                 std::move(*contents))
                           : nullptr);
            },
            std::move(callback), path == "index.html"));
    host->NoteAssetServed(path);
  }
};

class ShellController : public content::WebUIController {
 public:
  explicit ShellController(content::WebUI* ui) : WebUIController(ui) {
    webui::ShellHostView* host =
        WindowRegistry::Get().HostForShell(ui->GetWebContents());
    if (!host || !host->app_profile()) {
      return;
    }
    content::URLDataSource::Add(host->app_profile(),
                                std::make_unique<ShellDataSource>());
    ui->AddMessageHandler(std::make_unique<webui::ShellBridge>(
        ui->GetWebContents(), host->GetWeakPtr()));
  }
};

class ShellConfig : public content::DefaultWebUIConfig<ShellController> {
 public:
  ShellConfig()
      : DefaultWebUIConfig(ardia::desktop_webui_process::kShellScheme,
                           ardia::desktop_webui_process::kShellHost) {}
  bool IsWebUIEnabled(content::BrowserContext* context) override {
    return !Profile::FromBrowserContext(context)->IsOffTheRecord();
  }
};

void RefuseIncompleteMigration(StartupMigrationResult migration) {
  const std::string outcome =
      std::string(StartupMigrationOutcomeName(migration.outcome)) +
      (migration.outcome == StartupMigrationOutcome::kExited ||
               migration.exit_code != 0
           ? " " + base::NumberToString(migration.exit_code)
           : std::string());
  LOG(ERROR) << "Ardia WebUI shell: moving data from the previous version did "
                "not finish ("
             << outcome << "); not opening the shell on a partial copy";
  NoteForTest("webui shell: startup migration incomplete (" + outcome +
              "); quitting");
  const DWORD background =
      ::GetEnvironmentVariableW(L"ARDIA_BACKGROUND", nullptr, 0);
  if (background == 0) {
    ::MessageBoxW(nullptr,
                  L"Ardia couldn't finish moving your data from the previous "
                  L"version, so it didn't open, to keep that data safe.\n\n"
                  L"Open Ardia again to finish the move. Nothing was "
                  L"changed in the previous version's data.",
                  L"Ardia", MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
  }
  QuitAppWithExitCode(kStartupMigrationIncompleteExitCode);
}

void StartWithProfile(base::ListValue urls, Profile* profile) {
  if (!profile) {
    LOG(ERROR) << "Ardia WebUI shell: the shell profile did not load";
    QuitApp();
    return;
  }
  NoteForTest("webui shell: opening; UI from " +
              webui::AssetDirectory().AsUTF8Unsafe());
  WindowRegistry::Get().Start(profile, std::move(urls));
}

bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) {
  return WindowRegistry::Get().KeepsWindowWithoutTabs(browser);
}

BrowserWindowInterface* CompanionOwner(const BrowserWindowInterface* browser) {
  return WindowRegistry::Get().CompanionOwner(browser);
}

bool PresentCompanion(BrowserWindowInterface* browser, bool activate) {
  return WindowRegistry::Get().PresentCompanion(browser, activate);
}

bool IsCompanion(const BrowserWindowInterface* browser) {
  return WindowRegistry::Get().IsCompanion(browser);
}

int WindowTabCount(const BrowserWindowInterface* browser) {
  return WindowRegistry::Get().WindowTabCount(browser);
}

bool ShellPassesPoint(gfx::NativeView child, const gfx::Point& location) {
  return WindowRegistry::Get().ShellPassesPoint(child, location);
}

bool OffTheRecordNavigation(content::WebContents* source, const GURL& url) {
  return WindowRegistry::Get().OffTheRecordNavigation(source, url);
}

}

void RegisterWebUIShell() {
  content::WebUIConfigMap::GetInstance().AddWebUIConfig(
      std::make_unique<ShellConfig>());
}

void InstallWebUIShellHooks() {
  g_ardia_win_hosts_normal_windows = true;
  g_ardia_win_shell_frame = true;
  g_ardia_win_frame_view = &webui::CreateShellFrameView;
  g_ardia_keeps_window_without_tabs = &KeepsWindowWithoutTabs;
  g_ardia_linux_companion_owner = &CompanionOwner;
  g_ardia_linux_present_companion = &PresentCompanion;
  g_ardia_linux_is_companion = &IsCompanion;
  g_ardia_linux_window_tab_count = &WindowTabCount;
  g_ardia_linux_shell_passes_point = &ShellPassesPoint;
  g_ardia_linux_off_the_record_navigation = &OffTheRecordNavigation;
}

void OpenWebUIShell() {
  OpenWebUIShellWithUrls(base::ListValue());
}

void OpenWebUIShellWithUrls(base::ListValue urls) {
  if (WindowRegistry::Get().started()) {
    WindowRegistry::Get().Relaunched(std::move(urls));
    return;
  }
  const StartupMigrationResult migration =
      RunWebUIStartupMigration(*base::CommandLine::ForCurrentProcess());
  if (!StartupMigrationAllowsShell(migration)) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&RefuseIncompleteMigration, migration));
    return;
  }
  WithProfile(webui::kAppProfileName,
              base::BindOnce(&StartWithProfile, std::move(urls)));
}

void CloseWebUIShell() {
  WindowRegistry::Get().Stop();
}

bool WebUIShellPreTranslate(const MSG& msg) {
  return WindowRegistry::Get().PreTranslate(msg);
}

}
