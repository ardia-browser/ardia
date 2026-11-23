#include "ardia/win/webui/webui_shell.h"

#include <windows.h>

#include <dwmapi.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/linux/ac_linux_contract.h"
#include "ardia/desktop/ac_desktop_policy.h"
#include "ardia/linux/ac_linux_session.h"
#include "ardia/desktop/ac_desktop_window_state.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/host_bootstrap.h"
#include "ardia/win/ac_calls.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/main.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_caption_script.h"
#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/profiles/keep_alive/profile_keep_alive_types.h"
#include "chrome/browser/profiles/keep_alive/scoped_profile_keep_alive.h"
#include "chrome/browser/profiles/profile.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_delegate.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/webui_config.h"
#include "content/public/browser/webui_config_map.h"
#include "content/public/common/referrer.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/aura/window.h"
#include "ui/aura/window_targeter.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/accelerators/accelerator_manager.h"
#include "ui/base/hit_test.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/win/hwnd_metrics.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/layer_type.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/display/win/screen_win.h"
#include "ui/events/event.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/unhandled_keyboard_event_handler.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/view.h"
#include "ui/views/view_targeter.h"
#include "ui/views/view_targeter_delegate.h"
#include "ui/views/widget/desktop_aura/desktop_native_widget_aura.h"
#include "ui/views/widget/desktop_aura/desktop_window_tree_host_win.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/widget/widget_observer.h"
#include "ui/views/win/hwnd_util.h"
#include "ui/views/window/frame_view.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_win {

namespace {

constexpr char kWindowId[] = "main";
constexpr char kShellProfile[] = "default";
constexpr char kSessionName[] = "session.json";
constexpr int kDefaultWidth = 1280;
constexpr int kDefaultHeight = 800;
constexpr int kMinimumWidth = 480;
constexpr int kMinimumHeight = 360;
constexpr int kResizeCornerWidth = 16;
constexpr size_t kAssetLimit = 64 * 1024 * 1024;
constexpr size_t kUnhandledLimit = 400;
constexpr DWORD kMaximizeClickLimitMs = 5000;

class ShellWindow;
ShellWindow* g_shell = nullptr;

std::string String(const base::DictValue& value, std::string_view key) {
  const std::string* found = value.FindString(key);
  return found ? *found : std::string();
}

const base::ListValue* Arguments(const base::DictValue& value) {
  return value.FindList("args");
}

base::FilePath AssetDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-ui-dir")) {
    return command->GetSwitchValuePath("ardia-ui-dir");
  }
  base::FilePath directory;
  base::PathService::Get(base::DIR_EXE, &directory);
  return directory.AppendASCII("ardia-ui");
}

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
  if (ext == ".ico") return "image/x-icon";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".webp") return "image/webp";
  if (ext == ".gif") return "image/gif";
  if (ext == ".avif") return "image/avif";
  if (ext == ".woff") return "font/woff";
  if (ext == ".woff2") return "font/woff2";
  if (ext == ".ttf") return "font/ttf";
  if (ext == ".wav") return "audio/wav";
  return std::string();
}

base::FilePath SessionDirectory() {
  return base::FilePath(AppDataDirectory());
}

std::optional<base::DictValue> ReadSession(const base::FilePath& directory) {
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(directory.AppendASCII(kSessionName),
                                         &text,
                                         ardia::kLinuxSessionMaxBytes)) {
    return std::nullopt;
  }
  std::optional<base::Value> value = base::JSONReader::Read(
      text, base::JSON_PARSE_RFC, ardia::kLinuxSessionMaxDepth);
  if (!value || !value->is_dict()) {
    return std::nullopt;
  }
  return ardia::MergeLinuxSession(base::DictValue(), base::DictValue(),
                                      value->GetDict());
}

std::optional<base::DictValue> WriteSession(const base::FilePath& directory,
                                            base::DictValue base,
                                            base::DictValue local) {
  const std::optional<base::DictValue> previous = ReadSession(directory);
  const base::DictValue empty;
  std::optional<base::DictValue> merged =
      ardia::MergeLinuxSession(base, local, previous ? *previous : empty);
  if (!merged) {
    return std::nullopt;
  }
  const std::optional<std::string> json = base::WriteJsonWithOptions(
      *merged, base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION,
      ardia::kLinuxSessionMaxDepth);
  if (!json || json->size() > ardia::kLinuxSessionMaxBytes ||
      !base::CreateDirectory(directory) ||
      !base::ImportantFileWriter::WriteFileAtomically(
          directory.AppendASCII(kSessionName), *json)) {
    return std::nullopt;
  }
  return std::move(*merged);
}

std::optional<std::string> ReadAsset(base::FilePath directory,
                                     std::string path,
                                     std::string bootstrap_json,
                                     base::FilePath documents) {
  if (!ardia::desktop_policy::ValidAssetPath(path) || MimeType(path).empty()) {
    return std::nullopt;
  }
  if (path == "host-bootstrap.js") {
    std::optional<base::Value> bootstrap =
        base::JSONReader::Read(bootstrap_json, base::JSON_PARSE_RFC);
    if (!bootstrap || !bootstrap->is_dict()) {
      return std::nullopt;
    }
    if (std::optional<base::DictValue> session = ReadSession(documents)) {
      bootstrap->GetDict().Set("session", std::move(*session));
    }
    const std::optional<std::string> json = base::WriteJson(*bootstrap);
    if (!json) {
      return std::nullopt;
    }
    return "globalThis.__ardiaBootstrap=" + *json + ";\n" +
           ardia::kArdiaHostBootstrap + "\n" + kWindowsCaptionScript;
  }
  const base::FilePath root = base::MakeAbsoluteFilePath(directory);
  const base::FilePath file =
      base::MakeAbsoluteFilePath(directory.AppendASCII(path));
  if (root.empty() || file.empty() || !root.IsParent(file)) {
    return std::nullopt;
  }
  std::string contents;
  if (!base::ReadFileToStringWithMaxSize(file, &contents, kAssetLimit)) {
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

scoped_refptr<base::SequencedTaskRunner> FileRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

std::optional<gfx::Rect> RectFrom(const base::DictValue* rect) {
  if (!rect) {
    return std::nullopt;
  }
  const double x = rect->FindDouble("x").value_or(NAN);
  const double y = rect->FindDouble("y").value_or(NAN);
  const double width = rect->FindDouble("width").value_or(NAN);
  const double height = rect->FindDouble("height").value_or(NAN);
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || width < 0 || height < 0) {
    return std::nullopt;
  }
  return gfx::ToEnclosingRect(gfx::RectF(x, y, width, height));
}

void SubtractFromRegion(std::vector<gfx::Rect>& region, const gfx::Rect& cut) {
  std::vector<gfx::Rect> remaining;
  for (const gfx::Rect& piece : region) {
    gfx::Rect overlap = piece;
    overlap.Intersect(cut);
    if (overlap.IsEmpty()) {
      remaining.push_back(piece);
      continue;
    }
    for (const gfx::Rect& part :
         {gfx::Rect(piece.x(), piece.y(), piece.width(), overlap.y() - piece.y()),
          gfx::Rect(piece.x(), overlap.bottom(), piece.width(),
                    piece.bottom() - overlap.bottom()),
          gfx::Rect(piece.x(), overlap.y(), overlap.x() - piece.x(),
                    overlap.height()),
          gfx::Rect(overlap.right(), overlap.y(), piece.right() - overlap.right(),
                    overlap.height())}) {
      if (!part.IsEmpty()) {
        remaining.push_back(part);
      }
    }
  }
  region = std::move(remaining);
}

class ShellTargeter : public aura::WindowTargeter {
 public:
  explicit ShellTargeter(std::vector<gfx::Rect> shape)
      : shape_(std::move(shape)) {}

  std::unique_ptr<HitTestRects> GetExtraHitTestShapeRects(
      aura::Window* target) const override {
    if (target != window()) {
      return nullptr;
    }
    return std::make_unique<HitTestRects>(shape_);
  }

 private:
  const std::vector<gfx::Rect> shape_;
};

class ShellTransparency : public content::WebContentsObserver {
 public:
  explicit ShellTransparency(content::WebContents* shell)
      : content::WebContentsObserver(shell) {
    Apply();
  }

  void PrimaryPageChanged(content::Page& page) override { Apply(); }
  void RenderViewReady() override { Apply(); }

 private:
  void Apply() {
    web_contents()->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
    if (content::RenderWidgetHostView* view =
            web_contents()->GetRenderWidgetHostView()) {
      view->SetBackgroundColor(SK_ColorTRANSPARENT);
    }
  }
};

struct Page;

class PageEvents : public content::WebContentsObserver {
 public:
  PageEvents(Page* page, content::WebContents* contents)
      : content::WebContentsObserver(contents), page_(page) {}

  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void TitleWasSet(content::NavigationEntry* entry) override;
  void DidStartLoading() override;
  void DidStopLoading() override;

 private:
  raw_ptr<Page> page_;
};

struct Page {
  int id = 0;
  std::string key;
  std::string claim;
  std::string profile;
  uint64_t sequence = 1;
  std::unique_ptr<content::WebContents> contents;
  raw_ptr<views::WebView> view = nullptr;
  std::unique_ptr<PageEvents> events;
  bool visible = false;
};

class ShellFrame : public views::FrameView {
  METADATA_HEADER(ShellFrame, views::FrameView)

 public:
  ShellFrame() = default;
  ShellFrame(const ShellFrame&) = delete;
  ShellFrame& operator=(const ShellFrame&) = delete;
  ~ShellFrame() override = default;

  void SetMaximizeButton(std::optional<gfx::Rect> rect) {
    maximize_button_ = rect;
  }

  gfx::Rect GetBoundsForClientView() const override { return bounds(); }

  gfx::Rect GetWindowBoundsForClientBounds(
      const gfx::Rect& client_bounds) const override {
    return client_bounds;
  }

  int NonClientHitTest(const gfx::Point& point) override {
    views::Widget* widget = GetWidget();
    if (!widget || !bounds().Contains(point)) {
      return HTNOWHERE;
    }
    if (widget->IsFullscreen()) {
      return HTCLIENT;
    }
    if (!widget->IsMaximized()) {
      const int top = TopResizeThickness();
      const int component = GetHTComponentForFrame(
          point, gfx::Insets::TLBR(top, 0, 0, 0), top, kResizeCornerWidth,
          widget->widget_delegate()->CanResize());
      if (component != HTNOWHERE) {
        return component;
      }
    }
    if (maximize_button_ && maximize_button_->Contains(point)) {
      return HTMAXBUTTON;
    }
    return HTCLIENT;
  }

  void GetWindowMask(const gfx::Size& size, SkPath* window_mask) override {}
  void ResetWindowControls() override {}
  void UpdateWindowIcon() override {}
  void UpdateWindowTitle() override {}
  void SizeConstraintsChanged() override {}

 private:
  int TopResizeThickness() const {
    HWND hwnd = views::HWNDForWidget(GetWidget());
    if (!hwnd) {
      return 0;
    }
    const float scale =
        display::win::GetScreenWin()->GetScaleFactorForHWND(hwnd);
    return static_cast<int>(std::floor(
        ui::GetFrameThicknessFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) /
        scale));
  }

  std::optional<gfx::Rect> maximize_button_;
};

BEGIN_METADATA(ShellFrame)
END_METADATA

class ShellTreeHost : public views::DesktopWindowTreeHostWin {
 public:
  ShellTreeHost(views::internal::NativeWidgetDelegate* delegate,
                views::DesktopNativeWidgetAura* native_widget)
      : views::DesktopWindowTreeHostWin(delegate, native_widget) {}

  bool ShouldUseNativeFrame() const override { return true; }

  bool GetClientAreaInsets(gfx::Insets* insets,
                           int frame_thickness) const override {
    if (GetWidget()->IsFullscreen()) {
      *insets = gfx::Insets();
      return true;
    }
    *insets = gfx::Insets::TLBR(GetWidget()->IsMaximized() ? frame_thickness : 0,
                                frame_thickness, frame_thickness,
                                frame_thickness);
    return true;
  }

  bool GetDwmFrameInsetsInPixels(gfx::Insets* insets) const override {
    *insets = gfx::Insets();
    return true;
  }
};

class ShellContents : public views::View, public views::ViewTargeterDelegate {
  METADATA_HEADER(ShellContents, views::View)

 public:
  ShellContents() {
    SetEventTargeter(std::make_unique<views::ViewTargeter>(this));
  }

  ~ShellContents() override {
    shell_ = nullptr;
    pass_.clear();
    RemoveAllChildViews();
  }

  void SetShell(views::WebView* shell) { shell_ = shell; }

  void SetPassRegions(std::vector<gfx::Rect> pass) {
    pass_ = std::move(pass);
    ApplyShellInput();
  }

  const std::vector<gfx::Rect>& pass() const { return pass_; }

  gfx::Size GetMinimumSize() const override {
    return gfx::Size(kMinimumWidth, kMinimumHeight);
  }

  aura::Window* ChildWindowOf(views::WebView* view) const {
    if (!view || !view->web_contents() || !GetWidget()) {
      return nullptr;
    }
    aura::Window* content = GetWidget()->GetNativeWindow();
    aura::Window* window = view->web_contents()->GetNativeView();
    while (window && window->parent() && window->parent() != content) {
      window = window->parent();
    }
    return window && window->parent() == content ? window : nullptr;
  }

  aura::Window* ShellChildWindow() const { return ChildWindowOf(shell_); }

  bool IsPageChildWindow(aura::Window* window) const {
    for (views::View* view : children()) {
      if (view != shell_ &&
          ChildWindowOf(static_cast<views::WebView*>(view)) == window) {
        return true;
      }
    }
    return false;
  }

  bool PassesShellPoint(gfx::NativeView child, const gfx::Point& location) {
    if (pass_.empty() || !child || child != ShellChildWindow()) {
      return false;
    }
    gfx::Point point = location;
    views::View::ConvertPointFromWidget(shell_, &point);
    return std::ranges::any_of(
        pass_, [&](const gfx::Rect& rect) { return rect.Contains(point); });
  }

  void ApplyShellInput() {
    if (!shell_) {
      return;
    }
    aura::Window* container = ShellChildWindow();
    if (!container) {
      return;
    }
    std::vector<gfx::Rect> shape{gfx::Rect(shell_->size())};
    for (const gfx::Rect& rect : pass_) {
      SubtractFromRegion(shape, rect);
    }
    container->SetEventTargeter(
        std::make_unique<ShellTargeter>(std::move(shape)));
  }

  void Layout(PassKey) override {
    if (shell_) {
      shell_->SetBoundsRect(GetLocalBounds());
    }
    ApplyShellInput();
  }

  bool DoesIntersectRect(const views::View* target,
                         const gfx::Rect& rect) const override {
    if (target != shell_) {
      return views::ViewTargeterDelegate::DoesIntersectRect(target, rect);
    }
    gfx::Rect inside = rect;
    inside.Intersect(target->GetLocalBounds());
    if (inside.IsEmpty()) {
      return false;
    }
    std::vector<gfx::Rect> remaining{inside};
    for (const gfx::Rect& pass : pass_) {
      SubtractFromRegion(remaining, pass);
    }
    return !remaining.empty();
  }

 private:
  raw_ptr<views::WebView> shell_ = nullptr;
  std::vector<gfx::Rect> pass_;
};

BEGIN_METADATA(ShellContents)
END_METADATA

class ShellRootTargeter : public aura::WindowTargeter {
 public:
  explicit ShellRootTargeter(ShellContents* contents) : contents_(contents) {}

 protected:
  bool SubtreeShouldBeExploredForEvent(aura::Window* window,
                                       const ui::LocatedEvent& event) override {
    if (window->parent() == this->window() &&
        contents_->IsPageChildWindow(window) && !contents_->pass().empty()) {
      return window->IsVisible() && EventLocationInsideBounds(window, event);
    }
    return aura::WindowTargeter::SubtreeShouldBeExploredForEvent(window, event);
  }

 private:
  raw_ptr<ShellContents> contents_;
};

class Handler;

class ShellWindow : public views::WidgetDelegate,
                    public views::WidgetObserver,
                    public content::WebContentsDelegate,
                    public ui::AcceleratorTarget {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  explicit ShellWindow(Profile* profile)
      : profile_(profile),
        profile_keep_alive_(std::make_unique<ScopedProfileKeepAlive>(
            profile,
            ProfileKeepAliveOrigin::kAppWindow)) {
    g_shell = this;
    SetCanMaximize(true);
    SetCanMinimize(true);
    SetCanResize(true);
    SetTitle(u"Ardia");
  }

  ~ShellWindow() override {
    TearDown();
    widget_.reset();
    if (g_shell == this) {
      g_shell = nullptr;
    }
  }

  void TearDown() {
    if (torn_down_) {
      return;
    }
    RetireRenderer();
    torn_down_ = true;
    request_handler_.reset();
    DropPages();
    if (shell_ && shell_->web_contents()) {
      shell_->web_contents()->SetDelegate(nullptr);
    }
    transparency_.reset();
    if (contents_) {
      contents_->SetPassRegions({});
      contents_->SetShell(nullptr);
    }
    contents_ = nullptr;
    shell_ = nullptr;
    frame_ = nullptr;
    Note("shell torn down while its views were alive");
  }

  void DropPages() {
    for (auto& [id, page] : pages_) {
      if (page->view) {
        page->view->SetWebContents(nullptr);
      }
      page->events.reset();
    }
    pages_.clear();
    page_keep_alives_.clear();
  }

  void Show() {
    auto contents = std::make_unique<ShellContents>();
    contents_ = contents.get();
    auto shell = std::make_unique<views::WebView>(profile_);
    shell_ = shell.get();
    contents_->AddChildView(std::move(shell));
    contents_->SetShell(shell_);
    SetContentsView(std::move(contents));

    widget_ = std::make_unique<views::Widget>();
    views::Widget::InitParams params(
        views::Widget::InitParams::CLIENT_OWNS_WIDGET,
        views::Widget::InitParams::TYPE_WINDOW);
    params.delegate = this;
    params.name = "ArdiaWebUIShell";
    params.bounds = InitialBounds();
    auto* native_widget = new views::DesktopNativeWidgetAura(widget_.get());
    params.native_widget = native_widget;
    params.desktop_window_tree_host =
        new ShellTreeHost(widget_.get(), native_widget);
    widget_->Init(std::move(params));
    widget_observation_ = true;
    widget_->AddObserver(this);
    focus_manager_ = widget_->GetFocusManager();
    widget_->GetNativeWindow()->SetEventTargeter(
        std::make_unique<ShellRootTargeter>(contents_));

    shell_->GetWebContents()->SetDelegate(this);
    transparency_ = std::make_unique<ShellTransparency>(shell_->GetWebContents());
    shell_->LoadInitialURL(GURL("chrome://ardia/"));
    widget_->Show();
    RoundCorners();
    FocusShell();
  }

  void Activate() {
    if (!widget_) {
      return;
    }
    if (widget_->IsMinimized()) {
      widget_->Restore();
    }
    widget_->Activate();
  }

  Profile* profile() const { return profile_; }
  views::Widget* widget() const { return widget_.get(); }
  content::WebContents* shell_contents() const {
    return shell_ ? shell_->web_contents() : nullptr;
  }

  bool Trusted(content::WebUI* ui) const {
    content::WebContents* shell = shell_contents();
    if (!ui || !shell || ui->GetWebContents() != shell) {
      return false;
    }
    content::RenderFrameHost* frame = shell->GetPrimaryMainFrame();
    return frame && frame->IsRenderFrameLive() &&
           ui->GetRenderFrameHost() == frame && frame->GetWebUI() == ui &&
           frame->GetLastCommittedOrigin() ==
               url::Origin::Create(GURL("chrome://ardia/")) &&
           shell->GetLastCommittedURL().host() == "ardia";
  }

  uint64_t SetHandler(Handler* handler, content::WebUI* ui) {
    if (!Trusted(ui)) {
      return 0;
    }
    content::RenderFrameHost* frame = ui->GetRenderFrameHost();
    if (handler_ == handler &&
        renderer_document_.AsRenderFrameHostIfValid() == frame) {
      return renderer_generation_;
    }
    RetireRenderer();
    handler_ = handler;
    renderer_document_ = frame->GetWeakDocumentPtr();
    Note("shell document " + base::NumberToString(renderer_generation_) +
         " is live");
    return renderer_generation_;
  }

  bool OwnsHandler(const Handler* handler, uint64_t generation) const {
    content::RenderFrameHost* frame =
        renderer_document_.AsRenderFrameHostIfValid();
    return handler && handler_ == handler && generation &&
           renderer_generation_ == generation && frame &&
           shell_contents() && frame == shell_contents()->GetPrimaryMainFrame();
  }

  void ClearHandler(Handler* handler) {
    if (!handler || handler_ != handler) {
      return;
    }
    RetireRenderer();
  }

  uint64_t renderer_generation() const { return renderer_generation_; }

  void DeliverReply(base::WeakPtr<Handler> handler,
                    uint64_t generation,
                    std::string id,
                    bool success,
                    base::Value response);

  std::string BootstrapJson() const;

  void Emit(std::string_view module, std::string_view event,
            base::Value payload);

  void Invoke(const std::string& method, const base::DictValue& args,
              Done done);

  bool PreTranslate(const MSG& msg);

  void PageNavigated(Page* page);

  void Note(const std::string& line) const {
    LOG(WARNING) << "Ardia WebUI shell: " << line;
    NoteForTest("webui shell: " + line);
  }

  std::unique_ptr<views::FrameView> CreateFrameView(
      views::Widget* widget) override {
    auto frame = std::make_unique<ShellFrame>();
    frame_ = frame.get();
    return frame;
  }

  bool ShouldDescendIntoChildForEventHandling(
      gfx::NativeView child,
      const gfx::Point& location) override {
    return !(contents_ && contents_->PassesShellPoint(child, location));
  }

  void OnWidgetBoundsChanged(views::Widget* widget,
                             const gfx::Rect& bounds) override {
    ReportWindowState();
  }

  void OnWidgetShowStateChanged(views::Widget* widget) override {
    ReportWindowState();
  }

  void OnWidgetDestroying(views::Widget* widget) override {
    if (widget_observation_) {
      widget->RemoveObserver(this);
      widget_observation_ = false;
    }
    if (focus_manager_) {
      focus_manager_->UnregisterAccelerators(this);
      focus_manager_ = nullptr;
    }

    TearDown();
    Note("window closed");
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&QuitApp));
  }

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override {
    if (source == shell_contents()) {
      return nullptr;
    }
    source->GetController().LoadURLWithParams(
        content::NavigationController::LoadURLParams(params));
    return source;
  }

  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    return content::KeyboardEventProcessingResult::NOT_HANDLED;
  }

  bool HandleKeyboardEvent(content::WebContents* source,
                           const input::NativeWebKeyboardEvent& event) override {
    if (!focus_manager_) {
      return false;
    }
    return unhandled_keys_.HandleKeyboardEvent(event, focus_manager_);
  }

  bool AcceleratorPressed(const ui::Accelerator& accelerator) override {
    auto found = shortcuts_.find(accelerator);
    if (found == shortcuts_.end()) {
      return false;
    }
    const std::string command = String(found->second, "command");
    if (CommandFocusesShell(command)) {
      FocusShell();
    }
    base::DictValue payload;
    payload.Set("command", command);
    if (const base::Value* arg = found->second.Find("arg")) {
      payload.Set("arg", arg->Clone());
    } else {
      payload.Set("arg", base::Value());
    }
    payload.Set("windowId", kWindowId);
    payload.Set("shortcutModifiers", accelerator.modifiers());
    Emit("ArdiaShell", "onCommand", base::Value(std::move(payload)));
    return true;
  }

  bool CanHandleAccelerators() const override { return true; }

 private:
  static bool CommandFocusesShell(const std::string& command) {
    return command == "focusCommandBar" || command == "newTab" ||
           command == "newTabInGroup" || command == "findInPage" ||
           command == "findAndReplace" || command == "searchTabs" ||
           command == "tabSwitcher" || command == "openProfileMenu" ||
           command == "closeTab";
  }

  gfx::Rect InitialBounds() const {
    const display::Display display =
        display::Screen::Get()->GetPrimaryDisplay();
    const gfx::Rect area = display.work_area();
    const int width = std::min(kDefaultWidth, area.width());
    const int height = std::min(kDefaultHeight, area.height());
    return gfx::Rect(area.x() + (area.width() - width) / 2,
                     area.y() + (area.height() - height) / 2, width, height);
  }

  void RoundCorners() {
    HWND hwnd = views::HWNDForWidget(widget_.get());
    if (!hwnd) {
      return;
    }
    const DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
    ::DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &corners,
                            sizeof(corners));
  }


  void FocusShell() {
    if (!shell_) {
      return;
    }
    shell_->RequestFocus();
    if (content::WebContents* contents = shell_contents()) {
      contents->Focus();
    }
  }

  HWND Hwnd() const { return views::HWNDForWidget(widget_.get()); }

  void RetireRenderer() {
    if (torn_down_) {
      handler_ = nullptr;
      return;
    }
    const bool had_document = handler_ != nullptr;
    handler_ = nullptr;
    renderer_document_ = content::WeakDocumentPtr();
    ++renderer_generation_;
    if (!had_document) {
      return;
    }
    const size_t pages = pages_.size();
    DropPages();
    if (contents_) {
      contents_->SetPassRegions({});
    }
    if (frame_) {
      frame_->SetMaximizeButton(std::nullopt);
    }
    Note("shell document retired; generation is now " +
         base::NumberToString(renderer_generation_) + ", " +
         base::NumberToString(pages) + " pages of the old document dropped");
  }

  base::DictValue WindowState() const {
    base::DictValue state;
    state.Set("windowId", kWindowId);
    state.Set("maximized", widget_ && widget_->IsMaximized());
    state.Set("tiled", false);
    state.Set("fullScreen", widget_ && widget_->IsFullscreen());
    return state;
  }

  void ReportWindowState() {
    if (!widget_) {
      return;
    }
    const bool maximized = widget_->IsMaximized();
    if (reported_maximized_ == maximized) {
      return;
    }
    reported_maximized_ = maximized;
    Emit("ArdiaShell", ardia::desktop_window_state::kWindowStateEvent,
         base::Value(WindowState()));
  }

  base::ListValue WindowFrame() const {
    base::ListValue frame;
    const gfx::Rect bounds =
        widget_ ? widget_->GetWindowBoundsInScreen() : gfx::Rect();
    frame.Append(bounds.x());
    frame.Append(bounds.y());
    frame.Append(bounds.width());
    frame.Append(bounds.height());
    return frame;
  }

  void StartWindowMove(Done done) {
    HWND hwnd = Hwnd();
    if (!hwnd || (::GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) {
      return std::move(done).Run(true, base::Value(false));
    }
    std::move(done).Run(true, base::Value(true));
    ::ReleaseCapture();
    ::PostMessageW(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
  }

  void ToggleMaximize() {
    if (!widget_) {
      return;
    }
    if (widget_->IsMaximized()) {
      widget_->Restore();
    } else {
      widget_->Maximize();
    }
  }

  void CreatePage(const base::DictValue& args, Done done);
  void CreatePageIn(base::DictValue args,
                    Done done,
                    base::WeakPtr<Handler> origin,
                    uint64_t generation,
                    Profile* profile);
  void StartPage(base::DictValue args,
                 Done done,
                 base::WeakPtr<Handler> origin,
                 uint64_t generation);
  void SetViewport(const base::DictValue& args, Done done);
  void PageCommand(const base::DictValue& args, Done done);
  void ReleasePage(const base::DictValue& args, Done done);
  void ClosePage(const base::DictValue& args, Done done);
  void DropPage(int id);
  void SetInputRegions(const base::DictValue& args, Done done);
  void SetKeyboardShortcuts(const base::ListValue* values, Done done);
  void EngineCall(const std::string& name, const std::string& profile,
                  const base::Value* args, Done done);
  void NoteUnhandled(const std::string& method);
  Page* OwnedPage(const base::DictValue& args);
  base::DictValue NavigationEvent(Page* page);

  raw_ptr<Profile> profile_;
  std::unique_ptr<ScopedProfileKeepAlive> profile_keep_alive_;
  std::map<Profile*, std::unique_ptr<ScopedProfileKeepAlive>> page_keep_alives_;
  std::unique_ptr<views::Widget> widget_;
  bool widget_observation_ = false;
  raw_ptr<ShellContents> contents_ = nullptr;
  raw_ptr<views::WebView> shell_ = nullptr;
  raw_ptr<ShellFrame> frame_ = nullptr;
  raw_ptr<views::FocusManager> focus_manager_ = nullptr;
  raw_ptr<Handler> handler_ = nullptr;
  content::WeakDocumentPtr renderer_document_;
  uint64_t renderer_generation_ = 1;
  size_t dropped_replies_ = 0;
  std::unique_ptr<ShellTransparency> transparency_;
  std::map<int, std::unique_ptr<Page>> pages_;
  int next_page_ = 1;
  std::map<ui::Accelerator, base::DictValue> shortcuts_;
  views::UnhandledKeyboardEventHandler unhandled_keys_;
  std::optional<bool> reported_maximized_;
  bool maximize_pressed_ = false;
  bool painted_ = false;
  base::WeakPtr<Handler> request_handler_;
  bool torn_down_ = false;
  uint64_t request_generation_ = 0;
  DWORD maximize_pressed_at_ = 0;
  size_t logged_pass_regions_ = static_cast<size_t>(-1);
  std::vector<std::string> unhandled_;
  base::WeakPtrFactory<ShellWindow> weak_factory_{this};

  friend class Handler;
  friend class PageEvents;
};

void PageEvents::DidFinishNavigation(content::NavigationHandle* handle) {
  if (handle->IsInPrimaryMainFrame() && g_shell) {
    g_shell->PageNavigated(page_);
  }
}

void PageEvents::TitleWasSet(content::NavigationEntry* entry) {
  if (g_shell) {
    g_shell->PageNavigated(page_);
  }
}

void PageEvents::DidStartLoading() {
  if (g_shell) {
    g_shell->PageNavigated(page_);
  }
}

void PageEvents::DidStopLoading() {
  if (g_shell) {
    g_shell->PageNavigated(page_);
  }
}

class Handler : public content::WebUIMessageHandler,
                public content::WebContentsObserver {
 public:
  explicit Handler(content::WebContents* shell)
      : content::WebContentsObserver(shell) {}
  ~Handler() override {
    if (g_shell) {
      g_shell->ClearHandler(this);
    }
  }

  uint64_t generation() const { return generation_; }

  bool Live() {
    return g_shell && IsJavascriptAllowed() && g_shell->Trusted(web_ui()) &&
           g_shell->OwnsHandler(this, generation_);
  }

  void Send(std::string_view module, std::string_view event,
            const base::Value& payload) {
    if (!Live()) {
      return;
    }
    CallJavascriptFunction("__ardiaEvent", base::Value(module),
                           base::Value(event), payload);
  }

  void Reply(const std::string& id, bool success, base::Value response) {
    if (!Live()) {
      return;
    }
    CallJavascriptFunction("__ardiaReply", base::Value(id),
                           base::Value(success), response);
  }

  base::WeakPtr<Handler> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback(
        "ardiaRequest",
        base::BindRepeating(&Handler::Request, base::Unretained(this)));
  }

  void Activate() {
    if (!g_shell || !g_shell->Trusted(web_ui())) {
      return;
    }
    generation_ = g_shell->SetHandler(this, web_ui());
  }

  void PrimaryPageChanged(content::Page& page) override {
    if (&page.GetMainDocument() == web_ui()->GetRenderFrameHost()) {
      Activate();
    }
  }

  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) override {
    weak_factory_.InvalidateWeakPtrs();
    if (g_shell) {
      g_shell->ClearHandler(this);
    }
  }

  void OnJavascriptDisallowed() override {
    weak_factory_.InvalidateWeakPtrs();
    if (g_shell && !g_shell->OwnsHandler(this, generation_)) {
      g_shell->ClearHandler(this);
    }
  }

  void Request(const base::ListValue& arguments) {
    CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    if (!g_shell || !g_shell->Trusted(web_ui()) || arguments.size() != 3 ||
        !arguments[0].is_string() || !arguments[1].is_string() ||
        !arguments[2].is_dict()) {
      return;
    }
    if (!g_shell->OwnsHandler(this, generation_)) {
      Activate();
    }
    if (!g_shell->OwnsHandler(this, generation_)) {
      return;
    }
    const std::string id = arguments[0].GetString();
    if (id.empty() || id.size() > 256) {
      return;
    }
    AllowJavascript();
    g_shell->request_handler_ = weak_factory_.GetWeakPtr();
    g_shell->request_generation_ = generation_;
    const base::DictValue& args = arguments[2].GetDict();
    auto done = base::BindOnce(&ShellWindow::DeliverReply,
                               g_shell->weak_factory_.GetWeakPtr(),
                               weak_factory_.GetWeakPtr(), generation_, id);
    if (arguments[1].GetString() == "engine.call") {
      return g_shell->EngineCall(String(args, "name"), String(args, "profile"),
                                 args.Find("args"), std::move(done));
    }
    if (arguments[1].GetString() != "host.invoke") {
      return std::move(done).Run(
          false, base::Value("Unknown native transport operation"));
    }
    const base::DictValue* payload = args.FindDict("args");
    if (!payload) {
      return std::move(done).Run(
          false, base::Value("Host arguments must be an object"));
    }
    g_shell->Invoke(String(args, "method"), *payload, std::move(done));
  }

  uint64_t generation_ = 0;
  base::WeakPtrFactory<Handler> weak_factory_{this};
};

void ShellWindow::DeliverReply(base::WeakPtr<Handler> handler,
                               uint64_t generation,
                               std::string id,
                               bool success,
                               base::Value response) {
  if (!handler || !OwnsHandler(handler.get(), generation)) {
    ++dropped_replies_;
    Note("reply dropped: shell document " + base::NumberToString(generation) +
         " is not the live one (" + base::NumberToString(renderer_generation_) +
         "); " + base::NumberToString(dropped_replies_) + " dropped so far");
    return;
  }
  handler->Reply(id, success, std::move(response));
}

void ShellWindow::Emit(std::string_view module, std::string_view event,
                       base::Value payload) {
  if (handler_ && OwnsHandler(handler_, handler_->generation())) {
    handler_->Send(module, event, payload);
  }
}

std::string ShellWindow::BootstrapJson() const {
  base::DictValue info;
  info.Set("appName", "Ardia");
  info.Set("appVersion", std::string(version_info::GetVersionNumber()));
  info.Set("appBuild", "windows-webui-pilot");
  info.Set("bundleId", "dev.ardia.windows.webui");
  info.Set("configuration", "Release");
  info.Set("osVersion", base::SysInfo::OperatingSystemVersion());
  info.Set("osBuild", "Windows");
  info.Set("arch", base::SysInfo::OperatingSystemArchitecture());
  info.Set("model", "Windows");
  info.Set("memoryGB",
           base::SysInfo::AmountOfTotalPhysicalMemory().InBytes() /
               (1024.0 * 1024 * 1024));
  info.Set("locale", "en-US");
  info.Set("updates", false);
  info.Set("isolatedInstance", true);
  base::ListValue capabilities;
  for (const char* capability :
       {"ArdiaShell.startWindowMove", "ArdiaShell.captionDoubleClick",
        "ArdiaShell.windowIdentity", "shell.inputRegions",
        ardia::desktop_window_state::kWindowButtonLayoutCall,
        ardia::desktop_window_state::kWindowStateCall}) {
    capabilities.Append(capability);
  }
  for (const auto& route : ardiacore::linux_contract::kRoutes) {
    capabilities.Append(route.name);
  }
  base::DictValue native_modules;
  native_modules.Set("ArdiaApp",
                     base::DictValue().Set("systemInfo", std::move(info)));
  base::DictValue bootstrap;
  bootstrap.Set("windowId", kWindowId);
  bootstrap.Set("startup", true);
  bootstrap.Set("profileId", kShellProfile);
  bootstrap.Set("nativeModules", std::move(native_modules));
  bootstrap.Set("capabilities", std::move(capabilities));
  bootstrap.Set("glassPanels", false);
  bootstrap.Set("pageProfile", kShellProfile);
  bootstrap.Set("windowKind", "main");
  bootstrap.Set("shellZoom", 1.0);
  bootstrap.Set("documents", base::DictValue());
  return base::WriteJson(bootstrap).value_or("{}");
}

void ShellWindow::NoteUnhandled(const std::string& method) {
  if (unhandled_.size() >= kUnhandledLimit ||
      std::ranges::find(unhandled_, method) != unhandled_.end()) {
    return;
  }
  unhandled_.push_back(method);
  Note("unhandled host call " + method);
}

void ShellWindow::Invoke(const std::string& method,
                         const base::DictValue& args,
                         Done done) {
  const base::ListValue* values = Arguments(args);
  if (method == "tab.create") {
    return CreatePage(args, std::move(done));
  }
  if (method == "tab.viewport") {
    return SetViewport(args, std::move(done));
  }
  if (method == "tab.command") {
    return PageCommand(args, std::move(done));
  }
  if (method == "tab.release") {
    return ReleasePage(args, std::move(done));
  }
  if (method == "tab.close") {
    return ClosePage(args, std::move(done));
  }
  if (method == "shell.inputRegions") {
    return SetInputRegions(args, std::move(done));
  }
  if (method == "session.read") {
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadSession, SessionDirectory()),
        base::BindOnce(
            [](Done done, std::optional<base::DictValue> session) {
              std::move(done).Run(true, session ? base::Value(std::move(*session))
                                                : base::Value());
            },
            std::move(done)));
    return;
  }
  if (method == "session.write") {
    const base::DictValue* base = args.FindDict("base");
    const base::DictValue* session = args.FindDict("session");
    if (!base || !session) {
      return std::move(done).Run(
          false, base::Value("A session write needs a base and a session"));
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&WriteSession, SessionDirectory(),
                       base->Clone(), session->Clone()),
        base::BindOnce(
            [](Done done, std::optional<base::DictValue> merged) {
              if (!merged) {
                return std::move(done).Run(
                    false, base::Value("The session could not be saved"));
              }
              std::move(done).Run(true, base::Value(std::move(*merged)));
            },
            std::move(done)));
    return;
  }
  if (method == "ArdiaShell.setKeyboardShortcuts") {
    return SetKeyboardShortcuts(values, std::move(done));
  }
  if (method == "ArdiaShell.startWindowMove") {
    return StartWindowMove(std::move(done));
  }
  if (method == "ArdiaShell.captionDoubleClick" ||
      method == "ArdiaShell.toggleMaximizeWindow") {
    ToggleMaximize();
    return std::move(done).Run(true, base::Value(true));
  }
  if (method == "ArdiaShell.minimizeWindow") {
    if (widget_) {
      widget_->Minimize();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.closeWindow" ||
      method == "ArdiaShell.requestWindowClose" ||
      method == "ArdiaShell.quit") {
    std::move(done).Run(true, base::Value());
    if (widget_) {
      widget_->Close();
    }
    return;
  }
  if (method == "ArdiaShell.focusWindow") {
    Activate();
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.windowIdentity" || method == "ArdiaShell.windowIds") {
    base::ListValue ids;
    ids.Append(kWindowId);
    return std::move(done).Run(true, method == "ArdiaShell.windowIds"
                                         ? base::Value(std::move(ids))
                                         : base::Value(kWindowId));
  }
  if (method == "ArdiaShell.windowFrame") {
    return std::move(done).Run(true, base::Value(WindowFrame()));
  }
  if (method == ardia::desktop_window_state::kWindowStateCall) {
    return std::move(done).Run(true, base::Value(WindowState()));
  }
  if (method == ardia::desktop_window_state::kWindowButtonLayoutCall) {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("layout", ":minimize,maximize,close")
                              .Set("desktop", "windows")));
  }
  if (method == "ArdiaShell.setMaximizeButton") {
    const base::DictValue* rect = args.FindDict("rect");
    if (frame_) {
      frame_->SetMaximizeButton(RectFrom(rect));
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.isDarkAppearance") {
    return std::move(done).Run(true, base::Value(false));
  }
  if (method == "ArdiaShell.setWindowTitle") {
    if (values && !values->empty() && (*values)[0].is_string() && widget_) {
      SetTitle(base::UTF8ToUTF16((*values)[0].GetString()));
      widget_->UpdateWindowTitle();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.restoreShortcutFocus") {
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.shellPainted") {
    if (!painted_) {
      painted_ = true;
      MarkStartSettled();
      Note("shell painted; the start is settled");
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaShell.testDelayedReply" && ardiacore::TestInstance()) {
    const int delay =
        values && !values->empty() && (*values)[0].is_int()
            ? std::clamp((*values)[0].GetInt(), 0, 10000)
            : 1000;
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](Done done) { std::move(done).Run(true, base::Value("late")); },
            std::move(done)),
        base::Milliseconds(delay));
    return;
  }
  if (method == "engine.info") {
    return std::move(done).Run(
        true, base::Value(base::DictValue()
                              .Set("version",
                                   std::string(version_info::GetVersionNumber()))
                              .Set("shell", "webui")));
  }
  NoteUnhandled(method);
  std::move(done).Run(true, base::Value());
}

void ShellWindow::SetKeyboardShortcuts(const base::ListValue* values,
                                       Done done) {
  if (!focus_manager_ || !values || values->empty() ||
      !(*values)[0].is_list() || (*values)[0].GetList().size() > 256) {
    return std::move(done).Run(false,
                               base::Value("Invalid keyboard shortcut table"));
  }
  constexpr int kModifiers = ui::EF_SHIFT_DOWN | ui::EF_CONTROL_DOWN |
                             ui::EF_ALT_DOWN | ui::EF_COMMAND_DOWN;
  std::map<ui::Accelerator, base::DictValue> shortcuts;
  for (const base::Value& value : (*values)[0].GetList()) {
    if (!value.is_dict()) {
      return std::move(done).Run(false, base::Value("Invalid keyboard shortcut"));
    }
    const base::DictValue& binding = value.GetDict();
    const int key = binding.FindInt("keyCode").value_or(0);
    const int flags = binding.FindInt("modifiers").value_or(-1);
    const std::string command = String(binding, "command");
    if (key < 1 || key > 255 || flags < 0 || (flags & ~kModifiers) ||
        command.empty() || command.size() > 64) {
      return std::move(done).Run(false, base::Value("Invalid keyboard shortcut"));
    }
    shortcuts.emplace(
        ui::Accelerator(static_cast<ui::KeyboardCode>(key), flags),
        binding.Clone());
  }
  focus_manager_->UnregisterAccelerators(this);
  shortcuts_ = std::move(shortcuts);
  for (const auto& [accelerator, binding] : shortcuts_) {
    focus_manager_->RegisterAccelerator(
        accelerator, ui::AcceleratorManager::kNormalPriority, this);
  }
  std::move(done).Run(true, base::Value());
}

void ShellWindow::EngineCall(const std::string& name,
                             const std::string& profile,
                             const base::Value* args,
                             Done done) {
  const auto* route = ardiacore::linux_contract::FindRoute(name);
  ac_engine_call_t call =
      route ? FindEngineCall(std::string(route->service)) : nullptr;
  if (!call) {
    NoteUnhandled("engine.call " + name);
    return std::move(done).Run(
        false, base::Value(base::DictValue()
                               .Set("code", "ERR_UNKNOWN_CALL")
                               .Set("message", "This engine call is not in the "
                                               "Windows WebUI pilot")));
  }
  if (ParseProfileName(profile).off_the_record) {
    return std::move(done).Run(
        false, base::Value(base::DictValue()
                               .Set("code", "ERR_PROFILE")
                               .Set("message", "Private engine calls are not "
                                               "in the Windows WebUI pilot")));
  }
  std::string json = args && args->is_string() ? args->GetString() : "{}";
  struct Pending {
    Done done;
    std::string field;
  };
  WithProfile(
      profile,
      base::BindOnce(
          [](ac_engine_call_t call, std::string json, std::string field,
             Done done, Profile* resolved) {
            if (!resolved) {
              return std::move(done).Run(
                  false, base::Value(base::DictValue()
                                         .Set("code", "ERR_PROFILE")
                                         .Set("message", "profile not loaded")));
            }
            const std::string path = base::WideToUTF8(
                resolved->GetOriginalProfile()->GetPath().value());
            auto* pending = new Pending{std::move(done), std::move(field)};
            call(
                path.c_str(), json.c_str(),
                [](void* context, const char* reply) {
                  std::unique_ptr<Pending> owned(static_cast<Pending*>(context));
                  std::optional<base::Value> value =
                      reply ? base::JSONReader::Read(reply, base::JSON_PARSE_RFC)
                            : std::nullopt;
                  if (!value) {
                    return std::move(owned->done).Run(
                        false, base::Value("The engine reply is not JSON"));
                  }
                  if (value->is_dict() && value->GetDict().Find("error")) {
                    return std::move(owned->done).Run(true,
                                                      base::Value(reply));
                  }
                  if (owned->field == "null") {
                    value = base::Value();
                  } else if (!owned->field.empty()) {
                    const base::Value* field =
                        value->is_dict() ? value->GetDict().Find(owned->field)
                                         : nullptr;
                    value = field ? field->Clone() : base::Value();
                  }
                  std::move(owned->done)
                      .Run(true, base::Value(base::WriteJson(*value).value_or(
                                     "null")));
                },
                pending);
          },
          call, std::move(json), std::string(route->field), std::move(done)));
}

namespace {

std::optional<GURL> AllowedPageUrl(const std::string& requested) {
  std::string text = requested.empty() ? "about:blank" : requested;
  if (base::StartsWith(text, "ardia://",
                       base::CompareCase::INSENSITIVE_ASCII)) {
    text.replace(0, 8, "chrome://");
  }
  const GURL url(text);
  if (!url.is_valid() || url.SchemeIs("javascript")) {
    return std::nullopt;
  }
  const GURL inner = url.SchemeIs("view-source") ? GURL(url.GetContent()) : url;
  if (inner.SchemeIs("javascript") || inner.SchemeIs("view-source") ||
      (inner.SchemeIs("chrome") &&
       base::TrimString(inner.host(), ".", base::TRIM_TRAILING) == "ardia")) {
    return std::nullopt;
  }
  return url;
}

}

Page* ShellWindow::OwnedPage(const base::DictValue& args) {
  const std::optional<int> id = args.FindInt("id");
  auto found = id ? pages_.find(*id) : pages_.end();
  if (found == pages_.end() || found->second->claim != String(args, "claim")) {
    return nullptr;
  }
  return found->second.get();
}

void ShellWindow::CreatePage(const base::DictValue& args, Done done) {
  const std::string key = String(args, "key");
  const std::string claim = String(args, "claim");
  if (key.empty() || key.size() > 256 || claim.empty() || claim.size() > 256) {
    return std::move(done).Run(false,
                               base::Value("A key and a claim are required"));
  }
  const base::Value* requested_url = args.Find("url");
  if ((requested_url && !requested_url->is_string()) ||
      !AllowedPageUrl(String(args, "url"))) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  if (ParseProfileName(String(args, "profile")).off_the_record) {
    return std::move(done).Run(
        false, base::Value("Private pages are not in the Windows WebUI pilot"));
  }
  const int delay = ardiacore::TestInstance()
                      ? std::clamp(args.FindInt("testDelayMs").value_or(0), 0,
                                   10000)
                      : 0;
  auto start = base::BindOnce(&ShellWindow::StartPage,
                              weak_factory_.GetWeakPtr(), args.Clone(),
                              std::move(done), request_handler_,
                              request_generation_);
  if (delay > 0) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, std::move(start), base::Milliseconds(delay));
    return;
  }
  std::move(start).Run();
}

void ShellWindow::StartPage(base::DictValue args,
                            Done done,
                            base::WeakPtr<Handler> origin,
                            uint64_t generation) {
  if (!origin || !OwnsHandler(origin.get(), generation)) {
    Note("page creation dropped before its profile loaded: shell document " +
         base::NumberToString(generation) + " is not the live one (" +
         base::NumberToString(renderer_generation_) + ")");
    return std::move(done).Run(false,
                               base::Value("The shell document that asked "
                                           "for this page is gone"));
  }
  const std::string profile = String(args, "profile");
  WithProfile(profile,
              base::BindOnce(&ShellWindow::CreatePageIn,
                             weak_factory_.GetWeakPtr(), std::move(args),
                             std::move(done), std::move(origin), generation));
}

base::DictValue ShellWindow::NavigationEvent(Page* page) {
  content::WebContents* contents = page->contents.get();
  base::DictValue data;
  data.Set("url", contents->GetVisibleURL().spec());
  data.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
  data.Set("canGoBack", contents->GetController().CanGoBack());
  data.Set("canGoForward", contents->GetController().CanGoForward());
  data.Set("isLoading", contents->IsLoading());
  data.Set("themeColor", base::Value());
  data.Set("themeColorSource", base::Value());
  data.Set("committedUrl", contents->GetLastCommittedURL().spec());
  base::DictValue event;
  event.Set("name", "navigation");
  event.Set("data", std::move(data));
  return event;
}

void ShellWindow::CreatePageIn(base::DictValue args,
                               Done done,
                               base::WeakPtr<Handler> origin,
                               uint64_t generation,
                               Profile* profile) {
  if (!origin || !OwnsHandler(origin.get(), generation)) {
    Note("page creation dropped: shell document " +
         base::NumberToString(generation) + " is not the live one (" +
         base::NumberToString(renderer_generation_) + ")");
    return std::move(done).Run(false,
                               base::Value("The shell document that asked "
                                           "for this page is gone"));
  }
  if (!profile || !widget_ || !contents_) {
    return std::move(done).Run(false,
                               base::Value("The page's profile did not load"));
  }
  if (profile->IsOffTheRecord()) {
    return std::move(done).Run(
        false, base::Value("Private pages are not in the Windows WebUI pilot"));
  }
  const std::optional<GURL> url = AllowedPageUrl(String(args, "url"));
  if (!url) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  auto page = std::make_unique<Page>();
  page->id = next_page_++;
  page->key = String(args, "key");
  page->claim = String(args, "claim");
  page->profile = String(args, "profile");
  page->contents =
      content::WebContents::Create(content::WebContents::CreateParams(profile));
  page->contents->SetDelegate(this);
  page->events =
      std::make_unique<PageEvents>(page.get(), page->contents.get());
  auto view = std::make_unique<views::WebView>(profile);
  if (view->holder()->layer_managed_by_views()) {
    view->SetPaintToLayer(ui::LAYER_NOT_DRAWN);
    view->layer()->SetFillsBoundsOpaquely(false);
  }
  view->SetVisible(false);
  page->view = contents_->AddChildViewAt(std::move(view), 0);
  page->view->SetWebContents(page->contents.get());
  contents_->ReorderChildView(shell_, contents_->children().size());
  if (!page_keep_alives_.contains(profile) && profile != profile_) {
    page_keep_alives_[profile] = std::make_unique<ScopedProfileKeepAlive>(
        profile, ProfileKeepAliveOrigin::kAppWindow);
  }
  page->contents->GetController().LoadURL(
      *url, content::Referrer(), ui::PAGE_TRANSITION_AUTO_TOPLEVEL,
      std::string());
  contents_->ApplyShellInput();
  base::DictValue lease;
  lease.Set("claim", page->claim);
  lease.Set("rendererGeneration", "1");
  lease.Set("bindingGeneration", "1");
  lease.Set("documentEpoch", "1");
  base::ListValue events;
  events.Append(NavigationEvent(page.get()));
  base::DictValue snapshot;
  snapshot.Set("watermark", 1);
  snapshot.Set("events", std::move(events));
  base::DictValue identity;
  identity.Set("browserId", page->id);
  identity.Set("chromeTabId", page->id);
  identity.Set("lease", std::move(lease));
  identity.Set("snapshot", std::move(snapshot));
  Note("page " + base::NumberToString(page->id) + " created");
  pages_[page->id] = std::move(page);
  std::move(done).Run(true, base::Value(std::move(identity)));
}

void ShellWindow::PageNavigated(Page* page) {
  if (!page || !page->contents) {
    return;
  }
  base::DictValue delivery;
  delivery.Set("type", "pageEvent");
  delivery.Set("claim", page->claim);
  delivery.Set("rendererGeneration", "1");
  delivery.Set("bindingGeneration", "1");
  delivery.Set("documentEpoch", "1");
  delivery.Set("sequence", static_cast<int>(++page->sequence));
  delivery.Set("event", NavigationEvent(page));
  Emit("ArdiaWebView", base::NumberToString(page->id),
       base::Value(std::move(delivery)));
}

void ShellWindow::SetViewport(const base::DictValue& args, Done done) {
  Page* page = OwnedPage(args);
  if (!page || !page->view) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  const bool visible = args.FindBool("visible").value_or(false);
  const std::optional<gfx::Rect> rect = RectFrom(args.FindDict("rect"));
  if (visible && rect && !rect->IsEmpty()) {
    page->view->SetBoundsRect(*rect);
    page->view->SetVisible(true);
  } else {
    page->view->SetVisible(false);
  }
  page->visible = page->view->GetVisible();
  contents_->ApplyShellInput();
  std::move(done).Run(true, base::Value());
}

void ShellWindow::PageCommand(const base::DictValue& args, Done done) {
  Page* page = OwnedPage(args);
  if (!page || !page->contents) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  const std::string command = String(args, "command");
  const base::ListValue* values = Arguments(args);
  content::NavigationController& controller = page->contents->GetController();
  if (command == "loadUrl" && values && !values->empty() &&
      (*values)[0].is_string()) {
    const std::string& text = (*values)[0].GetString();
    const std::optional<GURL> url =
        text.empty() ? std::nullopt : AllowedPageUrl(text);
    if (!url) {
      return std::move(done).Run(false, base::Value("Invalid or reserved URL"));
    }
    controller.LoadURL(*url, content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                       std::string());
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goBack") {
    if (controller.CanGoBack()) {
      controller.GoBack();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goForward") {
    if (controller.CanGoForward()) {
      controller.GoForward();
    }
    return std::move(done).Run(true, base::Value());
  }
  if (command == "reload") {
    controller.Reload(content::ReloadType::NORMAL, true);
    return std::move(done).Run(true, base::Value());
  }
  if (command == "stopLoading") {
    page->contents->Stop();
    return std::move(done).Run(true, base::Value());
  }
  if (command == "focus") {
    if (page->view) {
      page->view->RequestFocus();
    }
    page->contents->Focus();
    return std::move(done).Run(true, base::Value());
  }
  if (command == "blur") {
    FocusShell();
    return std::move(done).Run(true, base::Value());
  }
  NoteUnhandled("tab.command " + command);
  std::move(done).Run(true, base::Value());
}

void ShellWindow::DropPage(int id) {
  auto found = pages_.find(id);
  if (found == pages_.end()) {
    return;
  }
  if (found->second->view && contents_) {
    found->second->view->SetWebContents(nullptr);
    contents_->RemoveChildViewT(found->second->view.get());
  }
  found->second->events.reset();
  pages_.erase(found);
  if (contents_) {
    contents_->ApplyShellInput();
  }
}

void ShellWindow::ReleasePage(const base::DictValue& args, Done done) {
  const std::optional<int> id = args.FindInt("id");
  auto found = id ? pages_.find(*id) : pages_.end();
  if (found == pages_.end()) {
    return std::move(done).Run(true, base::Value());
  }
  if (found->second->claim != String(args, "claim")) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  DropPage(*id);
  std::move(done).Run(true, base::Value());
}

void ShellWindow::ClosePage(const base::DictValue& args, Done done) {
  const std::string key = String(args, "key");
  std::vector<int> closing;
  for (const auto& [id, page] : pages_) {
    if (page->key == key) {
      closing.push_back(id);
    }
  }
  for (int id : closing) {
    DropPage(id);
  }
  std::move(done).Run(true, base::Value());
}

void ShellWindow::SetInputRegions(const base::DictValue& args, Done done) {
  const auto read = [](const base::ListValue* list,
                       std::vector<gfx::Rect>& out) {
    if (!list || list->size() > 64) {
      return false;
    }
    for (const base::Value& entry : *list) {
      const std::optional<gfx::Rect> rect = RectFrom(entry.GetIfDict());
      if (!rect) {
        return false;
      }
      if (!rect->IsEmpty()) {
        out.push_back(*rect);
      }
    }
    return true;
  };
  std::vector<gfx::Rect> pages;
  std::vector<gfx::Rect> overlays;
  if (!read(args.FindList("pages"), pages) ||
      !read(args.FindList("overlays"), overlays)) {
    return std::move(done).Run(
        false, base::Value("Input regions need pages and overlays as lists"));
  }
  std::vector<gfx::Rect> pass;
  for (const gfx::Rect& page : pages) {
    std::vector<gfx::Rect> open{page};
    for (const gfx::Rect& overlay : overlays) {
      SubtractFromRegion(open, overlay);
    }
    pass.insert(pass.end(), open.begin(), open.end());
  }
  if (pass.size() != logged_pass_regions_) {
    logged_pass_regions_ = pass.size();
    Note("input regions: " + base::NumberToString(pages.size()) + " pages, " +
         base::NumberToString(overlays.size()) + " overlays, " +
         base::NumberToString(pass.size()) + " pass-through rects" +
         (pass.empty() ? std::string() : ", first " + pass[0].ToString()));
  }
  if (contents_) {
    contents_->SetPassRegions(std::move(pass));
  }
  std::move(done).Run(true, base::Value());
}

bool IsSizingHit(WPARAM hit) {
  return hit == HTLEFT || hit == HTRIGHT || hit == HTTOP || hit == HTBOTTOM ||
         hit == HTTOPLEFT || hit == HTTOPRIGHT || hit == HTBOTTOMLEFT ||
         hit == HTBOTTOMRIGHT;
}

WPARAM SizeCommand(WPARAM hit) {
  switch (hit) {
    case HTLEFT: return SC_SIZE | WMSZ_LEFT;
    case HTRIGHT: return SC_SIZE | WMSZ_RIGHT;
    case HTTOP: return SC_SIZE | WMSZ_TOP;
    case HTBOTTOM: return SC_SIZE | WMSZ_BOTTOM;
    case HTTOPLEFT: return SC_SIZE | WMSZ_TOPLEFT;
    case HTTOPRIGHT: return SC_SIZE | WMSZ_TOPRIGHT;
    case HTBOTTOMLEFT: return SC_SIZE | WMSZ_BOTTOMLEFT;
    default: return SC_SIZE | WMSZ_BOTTOMRIGHT;
  }
}

const wchar_t* SizeCursor(WPARAM hit) {
  switch (hit) {
    case HTLEFT:
    case HTRIGHT: return IDC_SIZEWE;
    case HTTOP:
    case HTBOTTOM: return IDC_SIZENS;
    case HTTOPLEFT:
    case HTBOTTOMRIGHT: return IDC_SIZENWSE;
    default: return IDC_SIZENESW;
  }
}

bool ShellWindow::PreTranslate(const MSG& msg) {
  HWND root = Hwnd();
  const bool ours = root && msg.hwnd && ::GetAncestor(msg.hwnd, GA_ROOT) == root;
  const bool button =
      msg.message == WM_LBUTTONDOWN || msg.message == WM_LBUTTONUP ||
      msg.message == WM_RBUTTONDOWN || msg.message == WM_RBUTTONUP ||
      msg.message == WM_MBUTTONDOWN || msg.message == WM_MBUTTONUP ||
      msg.message == WM_XBUTTONDOWN || msg.message == WM_XBUTTONUP ||
      msg.message == WM_NCLBUTTONDOWN || msg.message == WM_NCLBUTTONUP ||
      msg.message == WM_NCRBUTTONDOWN || msg.message == WM_NCRBUTTONUP ||
      msg.message == WM_NCMBUTTONDOWN || msg.message == WM_NCMBUTTONUP ||
      msg.message == WM_NCXBUTTONDOWN || msg.message == WM_NCXBUTTONUP;
  if (button && !(ours && msg.wParam == HTMAXBUTTON &&
                  (msg.message == WM_NCLBUTTONDOWN ||
                   msg.message == WM_NCLBUTTONUP))) {
    maximize_pressed_ = false;
  }
  if (!ours) {
    return false;
  }
  const bool child = msg.hwnd != root;
  if (msg.message == WM_NCLBUTTONDOWN || msg.message == WM_NCLBUTTONDBLCLK) {
    if (msg.wParam == HTMAXBUTTON) {
      maximize_pressed_ = true;
      maximize_pressed_at_ = msg.time;
      return true;
    }
    if (child && IsSizingHit(msg.wParam)) {
      ::ReleaseCapture();
      ::SendMessageW(root, WM_SYSCOMMAND, SizeCommand(msg.wParam), msg.lParam);
      return true;
    }
    if (child && msg.wParam == HTCAPTION) {
      ::ReleaseCapture();
      ::SendMessageW(root, msg.message == WM_NCLBUTTONDBLCLK ? WM_NCLBUTTONDBLCLK
                                                            : WM_SYSCOMMAND,
                     msg.message == WM_NCLBUTTONDBLCLK ? HTCAPTION
                                                       : (SC_MOVE | HTCAPTION),
                     msg.lParam);
      return true;
    }
    return false;
  }
  if (msg.message == WM_NCLBUTTONUP && msg.wParam == HTMAXBUTTON) {
    if (maximize_pressed_ &&
        msg.time - maximize_pressed_at_ <= kMaximizeClickLimitMs) {
      ToggleMaximize();
    }
    maximize_pressed_ = false;
    return true;
  }
  if (msg.message == WM_NCMOUSEMOVE) {
    if (msg.wParam != HTMAXBUTTON) {
      maximize_pressed_ = false;
    }
    if (child && IsSizingHit(msg.wParam)) {
      ::SetCursor(::LoadCursorW(nullptr, SizeCursor(msg.wParam)));
    }
  }
  return false;
}

void RefuseMissingBundle() {
  const std::string folder = AssetDirectory().AsUTF8Unsafe();
  LOG(ERROR) << "Ardia WebUI shell: the shell UI could not load from "
             << folder << "; quitting";
  NoteForTest("webui shell: the shell UI could not load from " + folder +
              "; quitting");
  const DWORD background = ::GetEnvironmentVariableW(L"ARDIA_BACKGROUND",
                                                     nullptr, 0);
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
    return MimeType(AssetPath(url));
  }
  std::string GetContentSecurityPolicy(
      network::mojom::CSPDirectiveName directive) override {
    using Directive = network::mojom::CSPDirectiveName;
    switch (directive) {
      case Directive::DefaultSrc: return "default-src 'none';";
      case Directive::ScriptSrc: return "script-src 'self';";
      case Directive::TrustedTypes: return "trusted-types ardia-symbols;";
      case Directive::StyleSrc: return "style-src 'self' 'unsafe-inline';";
      case Directive::ImgSrc: return "img-src 'self' data: blob:;";
      case Directive::FontSrc: return "font-src 'self' data:;";
      case Directive::MediaSrc: return "media-src 'self';";
      case Directive::ConnectSrc: return "connect-src 'none';";
      case Directive::FrameSrc: return "frame-src 'none';";
      case Directive::ChildSrc: return "child-src 'none';";
      case Directive::ObjectSrc: return "object-src 'none';";
      case Directive::BaseURI: return "base-uri 'none';";
      case Directive::FormAction: return "form-action 'none';";
      default:
        return content::URLDataSource::GetContentSecurityPolicy(directive);
    }
  }
  void StartDataRequest(const GURL& url,
                        const content::WebContents::Getter& getter,
                        GotDataCallback callback) override {
    CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
    content::WebContents* contents = getter.Run();
    if (!g_shell || !contents || contents != g_shell->shell_contents() ||
        url.scheme() != "chrome" || url.host() != "ardia") {
      return std::move(callback).Run(nullptr);
    }
    FileRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&ReadAsset, AssetDirectory(), AssetPath(url),
                       g_shell->BootstrapJson(),
                       SessionDirectory()),
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
            std::move(callback), AssetPath(url) == "index.html"));
  }
};

class ShellController : public content::WebUIController {
 public:
  explicit ShellController(content::WebUI* ui) : WebUIController(ui) {
    if (!g_shell || ui->GetWebContents() != g_shell->shell_contents()) {
      return;
    }
    content::URLDataSource::Add(g_shell->profile(),
                                std::make_unique<ShellDataSource>());
    ui->AddMessageHandler(std::make_unique<Handler>(ui->GetWebContents()));
  }
};

class ShellConfig : public content::DefaultWebUIConfig<ShellController> {
 public:
  ShellConfig() : DefaultWebUIConfig("chrome", "ardia") {}
  bool IsWebUIEnabled(content::BrowserContext* context) override {
    return !Profile::FromBrowserContext(context)->IsOffTheRecord();
  }
};

std::unique_ptr<ShellWindow>& TheWindow() {
  static base::NoDestructor<std::unique_ptr<ShellWindow>> window;
  return *window;
}

void ShowWindowFor(Profile* profile) {
  if (!profile) {
    LOG(ERROR) << "Ardia WebUI shell: the shell profile did not load";
    QuitApp();
    return;
  }
  if (TheWindow()) {
    TheWindow()->Activate();
    return;
  }
  TheWindow() = std::make_unique<ShellWindow>(profile);
  TheWindow()->Note("window opening; UI from " +
                    AssetDirectory().AsUTF8Unsafe());
  TheWindow()->Show();
}

}

void RegisterWebUIShell() {
  content::WebUIConfigMap::GetInstance().AddWebUIConfig(
      std::make_unique<ShellConfig>());
}

void OpenWebUIShell() {
  WithProfile(kShellProfile, base::BindOnce(&ShowWindowFor));
}

void CloseWebUIShell() {
  TheWindow().reset();
}

bool WebUIShellPreTranslate(const MSG& msg) {
  return g_shell && g_shell->PreTranslate(msg);
}

}
