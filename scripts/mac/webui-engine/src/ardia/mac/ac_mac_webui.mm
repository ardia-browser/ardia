#include "ardia/mac/ac_mac_webui.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/core/ac_hooks.h"
#include "ardia/mac/ac_mac_glass_layout.h"
#include "ardia/mac/ac_mac_hooks.h"
#include "ardia/mac/ac_mac_menu.h"
#include "ardia/mac/ac_mac_page_delegate.h"
#include "ardia/mac/ac_mac_popover.h"
#include "ardia/mac/ac_mac_share.h"
#include "ardia/mac/ac_mac_shell_bridge.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_system.h"
#include "ardia/mac/ac_mac_webui_policy.h"
#include "ardia/mac/ac_mac_window.h"
#include "ardia/mac/host_bootstrap.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_split.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"
#include "content/public/browser/webui_config_map.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/base/base_window.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

#if !defined(ARDIA_MAC_WEBUI_DEV)
#error "ac_mac_webui.mm is the development WebUI shell; official builds compile ac_mac_webui_release.mm"
#endif

namespace ardia_mac {

namespace {

constexpr int kBackgroundLevel = -1000000;

std::string AssetPath(const GURL& url) {
  const std::string path(url.path());
  return path == "/" || path.empty() ? "index.html" : path.substr(1);
}

std::string MimeType(std::string_view path) {
  const size_t dot = path.rfind('.');
  const std::string_view ext =
      dot == std::string_view::npos ? std::string_view() : path.substr(dot);
  if (ext == ".html") return "text/html";
  if (ext == ".js" || ext == ".mjs") return "application/javascript";
  if (ext == ".css") return "text/css";
  if (ext == ".json") return "application/json";
  if (ext == ".svg") return "image/svg+xml";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".webp") return "image/webp";
  if (ext == ".woff2") return "font/woff2";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".ico") return "image/x-icon";
  return std::string();
}

bool ValidAssetPath(std::string_view path) {
  if (path.empty() || path.size() > 512 || path.front() == '/' ||
      path.find("..") != std::string_view::npos) {
    return false;
  }
  for (char c : path) {
    if (!(base::IsAsciiAlpha(c) || base::IsAsciiDigit(c) || c == '.' ||
          c == '_' || c == '-' || c == '/')) {
      return false;
    }
  }
  return true;
}

std::optional<std::string> ReadAsset(base::FilePath directory,
                                     std::string path,
                                     std::string bootstrap_json) {
  if (path == webui_policy::kBootstrapAsset) {
    return BootstrapScript(bootstrap_json, ardia::kArdiaHostBootstrap);
  }
  if (!ValidAssetPath(path) || MimeType(path).empty()) {
    return std::nullopt;
  }
  std::string contents;
  if (!base::ReadFileToStringWithMaxSize(directory.Append(path), &contents,
                                         64 * 1024 * 1024)) {
    return std::nullopt;
  }
  if (path == "index.html") {
    const size_t head = contents.find("<head>");
    if (head == std::string::npos) {
      return std::nullopt;
    }
    contents.insert(head + 6, "<script src=\"/host-bootstrap.js\"></script>");
  }
  return contents;
}

class ShellDataSource : public content::URLDataSource {
 public:
  std::string GetSource() override { return "ardia"; }
  bool AllowCaching() override { return false; }
  bool ShouldServeMimeTypeAsContentTypeHeader() override { return true; }
  std::string GetMimeType(const GURL& url) override {
    return MimeType(AssetPath(url));
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
    ShellHostView* host = HostForShell(contents);
    std::optional<std::string> bootstrap;
    if (host) {
      bootstrap = host->BootstrapJson();
    } else if ((host = HostForPopover(contents))) {
      bootstrap = host->PopoverBootstrapJson(contents);
    }
    if (!host || !bootstrap || url.scheme() != "chrome" || url.host() != "ardia") {
      return std::move(callback).Run(nullptr);
    }
    const std::string path = AssetPath(url);
    const scoped_refptr<base::TaskRunner> reader =
        webui_policy::ReadsSession(path)
            ? scoped_refptr<base::TaskRunner>(SessionFiles())
            : base::ThreadPool::CreateTaskRunner(
                  {base::MayBlock(), base::TaskPriority::USER_BLOCKING});
    reader->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&ReadAsset, AssetDirectory(), path, std::move(*bootstrap)),
        base::BindOnce(
            [](GotDataCallback callback, std::optional<std::string> contents) {
              std::move(callback).Run(
                  contents ? base::MakeRefCounted<base::RefCountedString>(
                                 std::move(*contents))
                           : nullptr);
            },
            std::move(callback)));
  }
};

class ShellController : public content::WebUIController {
 public:
  explicit ShellController(content::WebUI* ui) : WebUIController(ui) {
    content::WebContents* contents = ui->GetWebContents();
    if (ShellHostView* host = HostForShell(contents); host && host->app_profile()) {
      content::URLDataSource::Add(host->app_profile(),
                                  std::make_unique<ShellDataSource>());
      ui->AddMessageHandler(
          std::make_unique<ShellBridge>(contents, host->GetWeakPtr()));
      return;
    }
    if (ShellHostView* host = HostForPopover(contents); host && host->app_profile()) {
      content::URLDataSource::Add(host->app_profile(),
                                  std::make_unique<ShellDataSource>());
      ui->AddMessageHandler(
          std::make_unique<PopoverBridge>(contents, host->GetWeakPtr()));
    }
  }
};

class ShellConfig : public content::DefaultWebUIConfig<ShellController> {
 public:
  ShellConfig() : DefaultWebUIConfig("chrome", "ardia") {}
  bool IsWebUIEnabled(content::BrowserContext* context) override {
    return !Profile::FromBrowserContext(context)->IsOffTheRecord();
  }
};

bool PassesPoint(NSView* view, NSPoint point) {
  for (ShellHostView* host : Hosts()) {
    if (!host->OwnsShellNativeView(gfx::NativeView(view))) {
      continue;
    }
    const NSPoint local = [view convertPoint:point fromView:view.superview];
    const CGFloat y = view.isFlipped ? local.y : NSHeight(view.bounds) - local.y;
    return host->PassesShellPoint(local.x, y);
  }
  return false;
}

bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser) {
  for (ShellHostView* host : Hosts()) {
    if (host->browser() == browser || host->OwnsCompanion(browser)) {
      return true;
    }
  }
  return false;
}

struct LaunchWindow {
  std::string id = "main";
  gfx::Rect frame{80, 80, 1280, 800};
};

LaunchWindow ReadLaunchWindow() {
  LaunchWindow launch;
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  std::string text;
  if (base::ReadFileToStringWithMaxSize(DataDirectory().Append("session.json"),
                                        &text, 64 * 1024 * 1024)) {
    std::optional<base::Value> session =
        base::JSONReader::Read(text, base::JSON_PARSE_RFC);
    const base::DictValue* dict = session ? session->GetIfDict() : nullptr;
    const base::ListValue* order = dict ? dict->FindList("windowOrder") : nullptr;
    if (order && !order->empty() && (*order)[0].is_string()) {
      launch.id = (*order)[0].GetString();
    }
    const base::DictValue* window = nullptr;
    if (const base::DictValue* windows = dict ? dict->FindDict("windows") : nullptr) {
      window = windows->FindDict(launch.id);
    } else if (const base::ListValue* list = dict ? dict->FindList("windows") : nullptr) {
      for (const base::Value& entry : *list) {
        const base::DictValue* candidate = entry.GetIfDict();
        const std::string* id = candidate ? candidate->FindString("id") : nullptr;
        if (id && *id == launch.id) {
          window = candidate;
        }
      }
    }
    const base::ListValue* frame = window ? window->FindList("frame") : nullptr;
    if (frame && frame->size() == 4) {
      launch.frame = gfx::Rect(
          glass::ClampToInt((*frame)[0].GetIfDouble().value_or(80), 1e5),
          glass::ClampToInt((*frame)[1].GetIfDouble().value_or(80), 1e5),
          std::max(1, glass::ClampToInt((*frame)[2].GetIfDouble().value_or(1280), 1e5)),
          std::max(1, glass::ClampToInt((*frame)[3].GetIfDouble().value_or(800), 1e5)));
    }
  }
  if (command->HasSwitch("ardia-window-frame")) {
    std::vector<std::string> parts =
        base::SplitString(command->GetSwitchValueASCII("ardia-window-frame"), ",",
                          base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
    int values[4];
    if (parts.size() == 4 && base::StringToInt(parts[0], &values[0]) &&
        base::StringToInt(parts[1], &values[1]) &&
        base::StringToInt(parts[2], &values[2]) &&
        base::StringToInt(parts[3], &values[3])) {
      launch.frame = gfx::Rect(values[0], values[1], values[2], values[3]);
    }
  }
  return launch;
}

void OpenLaunchWindow(Profile* profile) {
  if (!profile) {
    Trace("the app profile did not load");
    return;
  }
  const LaunchWindow launch = ReadLaunchWindow();
  WindowSpec spec;
  spec.id = launch.id;
  OpenShellWindow(profile, std::move(spec), launch.frame);
}

webui_policy::Decision ShellDecision() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  const std::string shell_switch = command->GetSwitchValueASCII(
      std::string(webui_policy::kShellSwitch));
  const char* environment =
      getenv(std::string(webui_policy::kShellEnvironment).c_str());
  return webui_policy::Decide(
      webui_policy::CompiledBuild(),
      command->HasSwitch(std::string(webui_policy::kShellSwitch))
          ? std::optional<std::string_view>(shell_switch)
          : std::nullopt,
      environment ? std::optional<std::string_view>(environment) : std::nullopt);
}

}

ShellHostView* OpenShellWindow(Profile* profile,
                               WindowSpec spec,
                               std::optional<gfx::Rect> frame,
                               const OpenPlacement& placement) {
  if (!profile || profile->ShutdownStarted() ||
      GetBrowserWindowCreationStatusForProfile(*profile) !=
          BrowserWindowInterface::CreationStatus::kOk) {
    Trace("no profile to open window " + spec.id + " in");
    return nullptr;
  }
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL, *profile,
                                   false);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  if (frame) {
    params.initial_bounds = *frame;
  }
  params.initial_show_state = ui::mojom::WindowShowState::kNormal;
  BrowserWindowInterface* browser = CreateBrowserWindow(std::move(params));
  BrowserView* view = browser ? BrowserView::GetBrowserViewForBrowser(browser)
                              : nullptr;
  if (!view) {
    Trace("no BrowserView for the shell window");
    return nullptr;
  }
  const std::string id = spec.id;
  ApplyShellWindowStyle(view->GetWidget());
  ShellHostView* host = view->AddChildView(
      std::make_unique<ShellHostView>(browser, view, profile, std::move(spec)));
  host->Initialize();
  ardia_mac::SetTrafficLights(view->GetWidget(), window::Lights{});
  const window::Presentation presentation =
      window::PresentationFor(BackgroundInstance());
  NSWindow* ns_window = view->GetWidget()->GetNativeWindow().GetNativeNSWindow();
  if (presentation.lowest_level) {
    [ns_window setLevel:kBackgroundLevel];
  }
  if (presentation.order_out) {
    [ns_window orderOut:nil];
  }
  ShellHostView* behind = placement.behind.empty() ? nullptr : HostForWindow(placement.behind);
  views::Widget* behind_widget =
      behind && behind->browser() ? behind->GetWidget() : nullptr;
  const window::OpenPresentation opening = window::PresentationForOpen(
      BackgroundInstance(), placement.focus, behind_widget != nullptr, placement.maximized);
  if (presentation.show && opening.activate) {
    browser->GetWindow()->Show();
  } else if (presentation.show && opening.show) {
    ShowWithoutActivating(view->GetWidget(), opening.order_behind ? behind_widget : nullptr);
  }
  if (presentation.show && opening.maximize) {
    browser->GetWindow()->Maximize();
  }
  Trace("window " + id +
        (presentation.show ? " shown" : " kept off screen (background)"));
  return host;
}

bool WebUIShellRequested() {
  const webui_policy::Decision decision = ShellDecision();
  if (decision != webui_policy::Decision::kOff) {
    Trace(std::string("WebUI shell ") +
          std::string(webui_policy::Describe(decision)));
  }
  return webui_policy::Active(decision);
}

void StartWebUIShell() {
  if (!WebUIShellRequested()) {
    return;
  }
  if (BackgroundInstance()) {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    if (Method occluded = class_getInstanceMethod(
            NSWindow.class, NSSelectorFromString(@"isOccluded"))) {
      method_setImplementation(occluded,
                               imp_implementationWithBlock(^BOOL(id) {
                                 return NO;
                               }));
    }
  }
  g_ardia_mac_hosts_normal_windows = true;
  g_ardia_browser_window_factory = nullptr;
  g_ardia_viewless_browsers = false;
  g_ardia_keeps_window_without_tabs = &KeepsWindowWithoutTabs;
  g_ardia_mac_shell_passes_point = &PassesPoint;
  share::InstallPageMenu();
  InstallPageDelegate();
  content::WebUIConfigMap::GetInstance().AddWebUIConfig(
      std::make_unique<ShellConfig>());
  InstallDefaultMainMenu(MainMenuHandler());
  SetMenuWindowResolver(ShellMenuWindows());
  InstallOpenUrlsHook();
  WithProfile("", base::BindOnce(&OpenLaunchWindow));
}

}
