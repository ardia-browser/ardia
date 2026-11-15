// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/windows/popup_window.h"

#include <algorithm>
#include <map>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/modules/app_modules.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/security_state/content/content_utils.h"
#include "components/security_state/core/security_state.h"
#include "components/vector_icons/vector_icons.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/models/image_model.h"
#include "ui/color/color_id.h"
#include "ui/display/display.h"
#include "ui/display/screen.h"
#include "ui/gfx/text_constants.h"
#include "ui/views/background.h"
#include "ui/views/border.h"
#include "ui/views/controls/button/md_text_button.h"
#include "ui/views/controls/image_view.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/view.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace ardia_linux {

namespace {

constexpr gfx::Size kDefaultPageSize(500, 600);
constexpr gfx::Size kMinimumPageSize(200, 150);
constexpr int kBelowOpenerTop = 60;
constexpr int kStripInset = 10;
constexpr int kGlyphSize = 16;
constexpr int kGlyphIconSize = 12;
constexpr int kStripGap = 5;
constexpr base::TimeDelta kOpenAsTabWait = base::Seconds(5);

std::map<PopupWindow*, std::unique_ptr<PopupWindow>>& Popups() {
  static base::NoDestructor<std::map<PopupWindow*, std::unique_ptr<PopupWindow>>>
      popups;
  return *popups;
}

std::string HostAndPort(const GURL& url) {
  std::string host = base::ToLowerASCII(url.host());
  return url.has_port() ? host + ":" + std::string(url.port()) : host;
}

enum class Connection { kSecure, kInsecure, kCertificateError, kNone };

Connection ConnectionOf(content::WebContents* contents) {
  const GURL& url = contents->GetVisibleURL();
  std::unique_ptr<security_state::VisibleSecurityState> visible =
      security_state::GetVisibleSecurityState(contents);
  if (visible && security_state::HasMajorCertificateError(*visible)) {
    return Connection::kCertificateError;
  }
  const security_state::SecurityLevel level =
      visible ? security_state::GetSecurityLevel(*visible)
              : security_state::NONE;
  if (level == security_state::SECURE) {
    return Connection::kSecure;
  }
  if (level == security_state::WARNING || level == security_state::DANGEROUS ||
      url.SchemeIs(url::kHttpScheme) || url.SchemeIs(url::kWsScheme)) {
    return Connection::kInsecure;
  }
  return Connection::kNone;
}

class PopupContentsView : public views::View {
  METADATA_HEADER(PopupContentsView, views::View)

 public:
  PopupContentsView() = default;
  PopupContentsView(const PopupContentsView&) = delete;
  PopupContentsView& operator=(const PopupContentsView&) = delete;
  ~PopupContentsView() override = default;

  void set_parts(views::View* strip, views::View* page) {
    strip_ = strip;
    page_ = page;
  }

  gfx::Size GetMinimumSize() const override {
    return gfx::Size(kMinimumPageSize.width(),
                     kMinimumPageSize.height() +
                         PopupWindow::kOriginStripHeight);
  }

  void Layout(PassKey) override {
    const int strip = PopupWindow::kOriginStripHeight;
    if (strip_) {
      strip_->SetBounds(0, 0, width(), strip);
    }
    if (page_) {
      page_->SetBounds(0, strip, width(), std::max(height() - strip, 0));
    }
  }

 private:
  raw_ptr<views::View> strip_ = nullptr;
  raw_ptr<views::View> page_ = nullptr;
};

BEGIN_METADATA(PopupContentsView)
END_METADATA

}

class PopupOriginStrip : public views::View {
  METADATA_HEADER(PopupOriginStrip, views::View)

 public:
  explicit PopupOriginStrip(base::RepeatingClosure open_as_tab) {
    SetBackground(views::CreateSolidBackground(ui::kColorDialogBackground));
    SetBorder(views::CreateSolidSidedBorder(gfx::Insets::TLBR(0, 0, 1, 0),
                                            ui::kColorSeparator));
    glyph_ = AddChildView(std::make_unique<views::ImageView>());
    origin_ = AddChildView(std::make_unique<views::Label>());
    origin_->SetElideBehavior(gfx::ELIDE_HEAD);
    origin_->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    origin_->SetEnabledColor(ui::kColorLabelForeground);
    button_ = AddChildView(std::make_unique<views::MdTextButton>(
        base::BindRepeating(
            [](base::RepeatingClosure callback) { callback.Run(); },
            std::move(open_as_tab)),
        u"Open as Tab"));
    button_->SetStyle(ui::ButtonStyle::kText);
    button_->SetTooltipText(u"Open this page as a tab in your window");
  }
  PopupOriginStrip(const PopupOriginStrip&) = delete;
  PopupOriginStrip& operator=(const PopupOriginStrip&) = delete;
  ~PopupOriginStrip() override = default;

  void Describe(const std::string& url, Connection connection) {
    origin_->SetText(base::UTF8ToUTF16(PopupWindow::OriginText(url)));
    const gfx::VectorIcon* icon = &vector_icons::kInfoIcon;
    ui::ColorId color = ui::kColorIconSecondary;
    std::u16string description = u"Local or internal page";
    switch (connection) {
      case Connection::kSecure:
        icon = &vector_icons::kLockIcon;
        description = u"Connection is secure";
        break;
      case Connection::kCertificateError:
        color = ui::kColorAlertHighSeverity;
        [[fallthrough]];
      case Connection::kInsecure:
        icon = &vector_icons::kNotSecureWarningOldIcon;
        description = u"Connection is not secure";
        break;
      case Connection::kNone:
        break;
    }
    glyph_->SetImage(
        ui::ImageModel::FromVectorIcon(*icon, color, kGlyphIconSize));
    glyph_->SetTooltipText(description);
    origin_->SetTooltipText(std::u16string(origin_->GetText()));
  }

  std::u16string origin_text() const {
    return std::u16string(origin_->GetText());
  }
  views::MdTextButton* button() const { return button_; }

  void Layout(PassKey) override {
    const gfx::Rect inside = GetContentsBounds();
    const int middle = inside.y() + inside.height() / 2;
    glyph_->SetBounds(kStripInset, middle - kGlyphSize / 2, kGlyphSize,
                      kGlyphSize);
    const gfx::Size wanted = button_->GetPreferredSize();
    const int button_height = std::min(wanted.height(), inside.height());
    const int button_x = std::max(inside.right() - 4 - wanted.width(), 0);
    button_->SetBounds(button_x, middle - button_height / 2, wanted.width(),
                       button_height);
    const int left = kStripInset + kGlyphSize + kStripGap;
    origin_->SetBounds(left, inside.y(), std::max(button_x - kStripGap - left, 0),
                       inside.height());
  }

 private:
  raw_ptr<views::ImageView> glyph_ = nullptr;
  raw_ptr<views::Label> origin_ = nullptr;
  raw_ptr<views::MdTextButton> button_ = nullptr;
};

BEGIN_METADATA(PopupOriginStrip)
END_METADATA

std::string PopupWindow::OriginText(const std::string& text) {
  if (text.empty()) {
    return "about:blank";
  }
  const GURL url(text);
  if (!url.is_valid() || url.scheme().empty()) {
    const size_t colon = text.find(':');
    return colon == std::string::npos ? text : text.substr(0, colon + 1);
  }
  const std::string scheme(url.scheme());
  if (url.SchemeIsBlob() || url.SchemeIsFileSystem()) {
    const GURL inner(url.GetContent());
    const std::string origin =
        inner.is_valid() && inner.has_host()
            ? std::string(inner.scheme()) + "://" + HostAndPort(inner)
            : std::string();
    return scheme + ":" + origin;
  }
  if (url.has_host() && !url.SchemeIsFile()) {
    return scheme == url::kHttpsScheme ? HostAndPort(url)
                                       : scheme + "://" + HostAndPort(url);
  }
  if (url.SchemeIs(url::kAboutScheme)) {
    return "about:" + url.GetContent();
  }
  if (url.SchemeIsFile()) {
    return "file://" + std::string(url.path());
  }
  return scheme + ":";
}

void PopupWindow::Open(Browser* browser,
                       content::WebContents* contents,
                       const base::DictValue* features,
                       const gfx::Rect& opener_window) {
  const auto feature = [&](std::string_view key) -> std::optional<int> {
    std::optional<double> value =
        features ? features->FindDouble(key) : std::nullopt;
    return value ? std::optional<int>(static_cast<int>(*value)) : std::nullopt;
  };
  display::Screen* screen = display::Screen::Get();
  const display::Display display =
      !opener_window.IsEmpty() ? screen->GetDisplayMatching(opener_window)
                               : screen->GetPrimaryDisplay();
  const gfx::Rect area = display.work_area();
  gfx::Size size(
      std::max(feature("width").value_or(kDefaultPageSize.width()),
               kMinimumPageSize.width()),
      std::max(feature("height").value_or(kDefaultPageSize.height()),
               kMinimumPageSize.height()) +
          kOriginStripHeight);
  size.SetToMin(area.size());
  const std::optional<int> left = feature("x");
  const std::optional<int> top = feature("y");
  int x = 0;
  int y = 0;
  if (left || top) {
    x = left.value_or(!opener_window.IsEmpty()
                          ? opener_window.x() +
                                (opener_window.width() - size.width()) / 2
                          : area.x());
    y = top.value_or(!opener_window.IsEmpty()
                         ? opener_window.y() + kBelowOpenerTop
                         : area.y());
  } else if (!opener_window.IsEmpty()) {
    x = opener_window.x() + (opener_window.width() - size.width()) / 2;
    y = opener_window.y() + kBelowOpenerTop;
  } else {
    x = area.x() + (area.width() - size.width()) / 2;
    y = area.y() + (area.height() - size.height()) / 2;
  }
  x = std::clamp(x, area.x(), area.right() - size.width());
  y = std::clamp(y, area.y(), area.bottom() - size.height());
  auto popup = base::WrapUnique(
      new PopupWindow(browser, contents, gfx::Rect(gfx::Point(x, y), size)));
  PopupWindow* raw = popup.get();
  Popups()[raw] = std::move(popup);
  CountLinux("popupWindowsOpened");
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PopupWindow::ShowFirstTime,
                                raw->weak_factory_.GetWeakPtr()));
}

PopupWindow* PopupWindow::ForBrowser(const Browser* browser) {
  if (!browser) {
    return nullptr;
  }
  for (const auto& [raw, popup] : Popups()) {
    if (popup->browser_ == browser && !popup->dismissed_) {
      return raw;
    }
  }
  return nullptr;
}

int PopupWindow::Count() {
  int count = 0;
  for (const auto& [raw, popup] : Popups()) {
    count += !popup->dismissed_;
  }
  return count;
}

base::ListValue PopupWindow::DebugStates() {
  base::ListValue states;
  for (const auto& [raw, popup] : Popups()) {
    if (!popup->dismissed_) {
      states.Append(popup->DebugState());
    }
  }
  return states;
}

PopupWindow::PopupWindow(Browser* browser,
                         content::WebContents* contents,
                         const gfx::Rect& bounds)
    : content::WebContentsObserver(contents), browser_(browser) {
  SetCanResize(true);
  SetCanMaximize(true);
  SetCanMinimize(true);
  auto root = std::make_unique<PopupContentsView>();
  strip_ = root->AddChildView(std::make_unique<PopupOriginStrip>(
      base::BindRepeating(&PopupWindow::OpenAsTab,
                          weak_factory_.GetWeakPtr())));
  page_view_ = root->AddChildView(
      std::make_unique<views::WebView>(contents->GetBrowserContext()));
  root->set_parts(strip_, page_view_);
  SetContentsView(std::move(root));
  browser_->GetTabStripModel()->AddObserver(this);

  widget_ = std::make_unique<views::Widget>();
  views::Widget::InitParams params(
      views::Widget::InitParams::CLIENT_OWNS_WIDGET,
      views::Widget::InitParams::TYPE_WINDOW);
  params.delegate = this;
  params.bounds = bounds;
  params.name = "ArdiaPopupWindow";
  params.wm_class_name = "ardia";
  params.wm_class_class = "Ardia";
  params.wm_role_name = "ardia-popup";
  params.wayland_app_id = "ardia";
  widget_->Init(std::move(params));
  page_view_->SetWebContents(contents);
  Describe();
}

PopupWindow::~PopupWindow() {
  LetGoOfPage();
  if (browser_) {
    browser_->GetTabStripModel()->RemoveObserver(this);
  }
  for (auto& observer : modal_observers_) {
    observer.OnHostDestroying();
  }
  widget_.reset();
}

bool PopupWindow::IsActive() const {
  return widget_ && widget_->IsActive();
}

void PopupWindow::Activate() {
  if (!widget_ || dismissed_ || ardiacore::BackgroundInstance()) {
    return;
  }
  widget_->Activate();
}

void PopupWindow::ShowFirstTime() {
  if (!widget_ || dismissed_) {
    return;
  }
  if (ardiacore::BackgroundInstance()) {
    widget_->ShowInactive();
    return;
  }
  widget_->Show();
  widget_->Activate();
  if (page_view_) {
    page_view_->RequestFocus();
  }
  if (contents()) {
    contents()->Focus();
  }
}

void PopupWindow::CloseFromUser() {
  if (dismissed_) {
    return;
  }
  content::WebContents* page = contents();
  TabStripModel* model = browser_ ? browser_->GetTabStripModel() : nullptr;
  if (!page || !model ||
      model->GetIndexOfWebContents(page) == TabStripModel::kNoTab) {
    Dismiss();
    return;
  }
  CountLinux("popupWindowsClosedByUser");
  browser_->GetWindow()->Close();
}

void PopupWindow::OpenAsTab() {
  content::WebContents* page = contents();
  if (dismissed_ || !page) {
    return;
  }
  CountLinux("popupWindowsOpenedAsTab");
  Host::Get()->OfferPopupAsTab(browser_, page);
  if (widget_ && !dismissed_) {
    widget_->Hide();
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<PopupWindow> popup) {
              if (popup && !popup->dismissed_ && popup->widget_) {
                popup->ShowFirstTime();
              }
            },
            weak_factory_.GetWeakPtr()),
        kOpenAsTabWait);
  }
}

gfx::Rect PopupWindow::PageBoundsInScreen() const {
  return page_view_ ? page_view_->GetBoundsInScreen() : gfx::Rect();
}

base::DictValue PopupWindow::DebugState() const {
  base::DictValue state;
  state.Set("visible", widget_ && widget_->IsVisible());
  state.Set("active", IsActive());
  if (widget_) {
    const gfx::Rect bounds = widget_->GetWindowBoundsInScreen();
    state.Set("x", bounds.x());
    state.Set("y", bounds.y());
    state.Set("width", bounds.width());
    state.Set("height", bounds.height());
    state.Set("title", base::UTF16ToUTF8(GetWindowTitle()));
  }
  state.Set("origin",
            strip_ ? base::UTF16ToUTF8(strip_->origin_text()) : std::string());
  state.Set("url", contents() ? contents()->GetVisibleURL().spec()
                              : std::string());
  if (strip_ && strip_->button()) {
    const gfx::Rect button = strip_->button()->GetBoundsInScreen();
    base::DictValue at;
    at.Set("x", button.CenterPoint().x());
    at.Set("y", button.CenterPoint().y());
    state.Set("openAsTab", std::move(at));
  }
  return state;
}

bool PopupWindow::OnCloseRequested(views::Widget::ClosedReason reason) {
  if (dismissed_) {
    return true;
  }
  CloseFromUser();
  return dismissed_;
}

views::View* PopupWindow::GetInitiallyFocusedView() {
  return page_view_;
}

void PopupWindow::TitleWasSet(content::NavigationEntry* entry) {
  Describe();
}

void PopupWindow::PrimaryPageChanged(content::Page& page) {
  Describe();
}

void PopupWindow::DidChangeVisibleSecurityState() {
  Describe();
}

void PopupWindow::WebContentsDestroyed() {
  Dismiss();
}

void PopupWindow::Describe() {
  content::WebContents* page = contents();
  if (!page || !strip_) {
    return;
  }
  const std::string url = page->GetVisibleURL().spec();
  strip_->Describe(page->GetVisibleURL().is_empty() ? std::string() : url,
                   ConnectionOf(page));
  const std::u16string title = page->GetTitle();
  const bool page_title = !title.empty() && base::UTF16ToUTF8(title) != url &&
                          title != u"about:blank";
  SetTitle(page_title ? title : strip_->origin_text());
}

void PopupWindow::OnTabStripModelChanged(
    TabStripModel* tab_strip_model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  if (dismissed_) {
    return;
  }
  if (change.type() == TabStripModelChange::kReplaced) {
    const TabStripModelChange::Replace* replace = change.GetReplace();
    if (replace->old_contents == contents()) {
      Observe(replace->new_contents);
      if (page_view_) {
        page_view_->SetWebContents(replace->new_contents);
      }
      Describe();
    }
    return;
  }
  if (change.type() != TabStripModelChange::kRemoved) {
    return;
  }
  for (const auto& removed : change.GetRemove()->contents) {
    if (removed.contents == contents()) {
      Dismiss();
      return;
    }
  }
}

void PopupWindow::OnTabStripModelDestroyed(TabStripModel* tab_strip_model) {
  browser_ = nullptr;
  Dismiss();
}

void PopupWindow::LetGoOfPage() {
  if (page_view_) {
    page_view_->SetWebContents(nullptr);
  }
  Observe(nullptr);
}

void PopupWindow::Dismiss() {
  if (dismissed_) {
    return;
  }
  dismissed_ = true;
  LetGoOfPage();
  if (browser_) {
    browser_->GetTabStripModel()->RemoveObserver(this);
    browser_ = nullptr;
  }
  if (widget_) {
    widget_->Hide();
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](PopupWindow* popup) { Popups().erase(popup); },
                     base::Unretained(this)));
}

gfx::NativeView PopupWindow::GetHostView() const {
  return widget_ ? widget_->GetNativeView() : gfx::NativeView();
}

gfx::Point PopupWindow::GetDialogPosition(const gfx::Size& size) {
  const int width = widget_ ? widget_->GetClientAreaBoundsInScreen().width()
                            : size.width();
  return gfx::Point(std::max((width - size.width()) / 2, 0),
                    kOriginStripHeight);
}

bool PopupWindow::ShouldActivateDialog() const {
  return IsActive();
}

gfx::Size PopupWindow::GetMaximumDialogSize() {
  return page_view_ ? page_view_->size() : gfx::Size();
}

void PopupWindow::AddObserver(web_modal::ModalDialogHostObserver* observer) {
  if (!modal_observers_.HasObserver(observer)) {
    modal_observers_.AddObserver(observer);
  }
}

void PopupWindow::RemoveObserver(web_modal::ModalDialogHostObserver* observer) {
  modal_observers_.RemoveObserver(observer);
}

}
