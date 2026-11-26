#include "ardia/win/webui/webui_frame.h"

#include <windows.h>

#include <cmath>
#include <memory>
#include <optional>
#include <utility>

#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/browser_widget.h"
#include "ui/base/hit_test.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/win/hwnd_metrics.h"
#include "ui/display/win/screen_win.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/views/view_utils.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"
#include "ui/views/win/hwnd_util.h"

namespace ardia_win::webui {

namespace {

bool IsSizingHit(WPARAM hit) {
  return hit == HTLEFT || hit == HTRIGHT || hit == HTTOP || hit == HTBOTTOM ||
         hit == HTTOPLEFT || hit == HTTOPRIGHT || hit == HTBOTTOMLEFT ||
         hit == HTBOTTOMRIGHT;
}

WPARAM SizeCommand(WPARAM hit) {
  switch (hit) {
    case HTLEFT:
      return SC_SIZE | WMSZ_LEFT;
    case HTRIGHT:
      return SC_SIZE | WMSZ_RIGHT;
    case HTTOP:
      return SC_SIZE | WMSZ_TOP;
    case HTBOTTOM:
      return SC_SIZE | WMSZ_BOTTOM;
    case HTTOPLEFT:
      return SC_SIZE | WMSZ_TOPLEFT;
    case HTTOPRIGHT:
      return SC_SIZE | WMSZ_TOPRIGHT;
    case HTBOTTOMLEFT:
      return SC_SIZE | WMSZ_BOTTOMLEFT;
    default:
      return SC_SIZE | WMSZ_BOTTOMRIGHT;
  }
}

const wchar_t* SizeCursor(WPARAM hit) {
  switch (hit) {
    case HTLEFT:
    case HTRIGHT:
      return IDC_SIZEWE;
    case HTTOP:
    case HTBOTTOM:
      return IDC_SIZENS;
    case HTTOPLEFT:
    case HTBOTTOMRIGHT:
      return IDC_SIZENWSE;
    default:
      return IDC_SIZENESW;
  }
}

constexpr UINT_PTR kPointerWatchTimer = 0x41524d58;
constexpr UINT kPointerWatchMs = 100;

bool IsMouseButtonMessage(UINT message) {
  return (message >= WM_LBUTTONDOWN && message <= WM_MBUTTONDBLCLK) ||
         (message >= WM_XBUTTONDOWN && message <= WM_XBUTTONDBLCLK) ||
         (message >= WM_NCLBUTTONDOWN && message <= WM_NCMBUTTONDBLCLK) ||
         (message >= WM_NCXBUTTONDOWN && message <= WM_NCXBUTTONDBLCLK);
}

bool PrimaryButtonDownOrQueued() {
  const int primary =
      ::GetSystemMetrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON;
  if ((::GetAsyncKeyState(primary) & 0x8000) != 0) {
    return true;
  }
  return (HIWORD(::GetQueueStatus(QS_MOUSEBUTTON)) & QS_MOUSEBUTTON) != 0;
}

bool IsMaximizeButtonInput(UINT message, WPARAM hit) {
  return hit == HTMAXBUTTON &&
         (message == WM_NCMOUSEMOVE || message == WM_NCLBUTTONDOWN ||
          message == WM_NCLBUTTONDBLCLK || message == WM_NCLBUTTONUP);
}

}

ShellBrowserFrameView::ShellBrowserFrameView(BrowserWidget* widget,
                                             BrowserView* browser_view)
    : BrowserFrameView(widget, browser_view) {}

ShellBrowserFrameView::~ShellBrowserFrameView() = default;

void ShellBrowserFrameView::SetMaximizeButton(std::optional<gfx::Rect> rect) {
  maximize_button_ = rect;
}

int ShellBrowserFrameView::GetTopInset(bool restored) const {
  return 0;
}

void ShellBrowserFrameView::UpdateThrobber(bool running) {}

gfx::Rect ShellBrowserFrameView::GetBoundsForClientView() const {
  return bounds();
}

gfx::Rect ShellBrowserFrameView::GetWindowBoundsForClientBounds(
    const gfx::Rect& client_bounds) const {
  return client_bounds;
}

int ShellBrowserFrameView::NonClientHitTest(const gfx::Point& point) {
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

int ShellBrowserFrameView::TopResizeThickness() const {
  HWND hwnd = views::HWNDForWidget(GetWidget());
  if (!hwnd) {
    return 0;
  }
  const float scale = display::win::GetScreenWin()->GetScaleFactorForHWND(hwnd);
  return static_cast<int>(std::floor(
      ui::GetFrameThicknessFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) / scale));
}

BEGIN_METADATA(ShellBrowserFrameView)
END_METADATA

std::unique_ptr<BrowserFrameView> CreateShellFrameView(
    BrowserWidget* widget,
    BrowserView* browser_view) {
  return std::make_unique<ShellBrowserFrameView>(widget, browser_view);
}

ShellBrowserFrameView* ShellFrameOf(BrowserView* browser_view) {
  if (!browser_view || !browser_view->browser_widget()) {
    return nullptr;
  }
  return views::AsViewClass<ShellBrowserFrameView>(
      browser_view->browser_widget()->GetFrameView());
}

CaptionInput::CaptionInput(StateChanged changed,
                           base::RepeatingClosure toggle_maximize,
                           base::RepeatingCallback<bool()> intercept_close)
    : changed_(std::move(changed)),
      toggle_maximize_(std::move(toggle_maximize)),
      intercept_close_(std::move(intercept_close)) {}

CaptionInput::~CaptionInput() {
  Detach();
}

void CaptionInput::Attach(HWND root) {
  if (root_ == root) {
    return;
  }
  Detach();
  root_ = root;
  if (root_) {
    ui::HWNDSubclass::AddFilterToTarget(root_, this);
  }
}

void CaptionInput::Detach() {
  StopWatchingPointer();
  ui::HWNDSubclass::RemoveFilterFromAllTargets(this);
  root_ = nullptr;
  state_.Reset();
}

void CaptionInput::Reset() {
  Publish(state_.Reset());
}

void CaptionInput::Emit() {
  if (changed_) {
    changed_.Run(state_.state());
  }
}

void CaptionInput::Publish(bool changed) {
  if (state_.state() == MaximizeButtonVisualState{}) {
    StopWatchingPointer();
  } else {
    WatchPointer();
  }
  if (changed) {
    Emit();
  }
}

void CaptionInput::WatchPointer() {
  if (watching_pointer_ || !root_) {
    return;
  }
  watching_pointer_ =
      ::SetTimer(root_, kPointerWatchTimer, kPointerWatchMs, nullptr) != 0;
}

void CaptionInput::StopWatchingPointer() {
  if (!watching_pointer_) {
    return;
  }
  watching_pointer_ = false;
  if (root_) {
    ::KillTimer(root_, kPointerWatchTimer);
  }
}

bool CaptionInput::PointerOnMaximizeButton() const {
  if (!root_) {
    return false;
  }
  POINT point{};
  if (!::GetCursorPos(&point)) {
    const DWORD position = ::GetMessagePos();
    point.x = static_cast<short>(LOWORD(position));
    point.y = static_cast<short>(HIWORD(position));
  }
  const HWND under = ::WindowFromPoint(point);
  if (!under || ::GetAncestor(under, GA_ROOT) != root_) {
    return false;
  }
  return ::SendMessageW(root_, WM_NCHITTEST, 0,
                        MAKELPARAM(point.x, point.y)) == HTMAXBUTTON;
}

void CaptionInput::Track(bool on_max_button) {
  Publish(
      state_.OnPointerChecked(on_max_button, PrimaryButtonDownOrQueued()));
}

void CaptionInput::Press() {
  maximize_pressed_at_ = static_cast<DWORD>(::GetMessageTime());
  Publish(state_.OnNcLeftButtonDown(true));
}

void CaptionInput::Release() {
  const bool was_pressed = state_.state().pressed;
  const DWORD held =
      static_cast<DWORD>(::GetMessageTime()) - maximize_pressed_at_;
  Publish(state_.OnNcLeftButtonUp(true));
  if (MaximizeClickCompletes(was_pressed, true, held) && toggle_maximize_) {
    toggle_maximize_.Run();
  }
}

void CaptionInput::LeaveReported() {
  if (state_.state() == MaximizeButtonVisualState{}) {
    StopWatchingPointer();
    return;
  }
  Publish(state_.OnPointerChecked(PointerOnMaximizeButton(),
                                  PrimaryButtonDownOrQueued()));
}

void CaptionInput::CancelPress() {
  if (state_.state() == MaximizeButtonVisualState{}) {
    return;
  }
  Publish(state_.OnPressCancelled(PointerOnMaximizeButton()));
}

bool CaptionInput::FilterMessage(HWND hwnd,
                                 UINT message,
                                 WPARAM w_param,
                                 LPARAM l_param,
                                 LRESULT* l_result) {
  if (hwnd != root_) {
    return false;
  }
  switch (message) {
    case WM_NCMOUSEMOVE:
      Track(w_param == HTMAXBUTTON);
      return false;
    case WM_NCLBUTTONDOWN:
    case WM_NCLBUTTONDBLCLK:
      if (w_param != HTMAXBUTTON) {
        CancelPress();
        return false;
      }
      Press();
      *l_result = 0;
      return true;
    case WM_NCLBUTTONUP:
      if (w_param != HTMAXBUTTON) {
        Publish(state_.OnNcLeftButtonUp(false));
        return false;
      }
      Release();
      *l_result = 0;
      return true;
    case WM_NCMOUSELEAVE:
    case WM_MOUSEMOVE:
    case WM_MOUSELEAVE:
      LeaveReported();
      return false;
    case WM_CAPTURECHANGED:
    case WM_CANCELMODE:
      CancelPress();
      return false;
    case WM_ACTIVATE:
      if (LOWORD(w_param) == WA_INACTIVE) {
        Reset();
      }
      return false;
    case WM_TIMER:
      if (w_param != kPointerWatchTimer) {
        return false;
      }
      LeaveReported();
      *l_result = 0;
      return true;
    case WM_CLOSE:
      if (intercept_close_ && intercept_close_.Run()) {
        *l_result = 0;
        return true;
      }
      return false;
    default:
      if (IsMouseButtonMessage(message)) {
        CancelPress();
      }
      return false;
  }
}

bool CaptionInput::PreTranslate(const MSG& msg) {
  const HWND root = root_;
  if (!root || !msg.hwnd || msg.hwnd == root) {
    return false;
  }
  if (::GetAncestor(msg.hwnd, GA_ROOT) != root) {
    if (IsMouseButtonMessage(msg.message)) {
      Reset();
    }
    return false;
  }
  if (IsMaximizeButtonInput(msg.message, msg.wParam)) {
    ::SendMessageW(root, msg.message, msg.wParam, msg.lParam);
    return true;
  }
  switch (msg.message) {
    case WM_MOUSEMOVE:
    case WM_MOUSELEAVE:
    case WM_NCMOUSELEAVE:
      LeaveReported();
      return false;
    case WM_NCMOUSEMOVE:
      Track(false);
      if (IsSizingHit(msg.wParam)) {
        ::SetCursor(::LoadCursorW(nullptr, SizeCursor(msg.wParam)));
      }
      return false;
    default:
      break;
  }
  if (!IsMouseButtonMessage(msg.message)) {
    return false;
  }
  CancelPress();
  if (msg.message != WM_NCLBUTTONDOWN && msg.message != WM_NCLBUTTONDBLCLK) {
    return false;
  }
  if (IsSizingHit(msg.wParam)) {
    ::ReleaseCapture();
    ::SendMessageW(root, WM_SYSCOMMAND, SizeCommand(msg.wParam), msg.lParam);
    return true;
  }
  if (msg.wParam == HTCAPTION) {
    ::ReleaseCapture();
    ::SendMessageW(root,
                   msg.message == WM_NCLBUTTONDBLCLK ? WM_NCLBUTTONDBLCLK
                                                     : WM_SYSCOMMAND,
                   msg.message == WM_NCLBUTTONDBLCLK ? HTCAPTION
                                                     : (SC_MOVE | HTCAPTION),
                   msg.lParam);
    return true;
  }
  return false;
}

}
