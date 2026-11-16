#include "ardia/win/frame_view.h"

#include <windows.h>

#include <cmath>

#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/display/win/screen_win.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_util.h"

namespace ardia_win {

namespace {

constexpr wchar_t kHostedPage[] = L"ArdiaHostedPage";

bool IsTopEdge(LRESULT hit) {
  return hit == HTTOP || hit == HTTOPLEFT || hit == HTTOPRIGHT;
}

WPARAM SizeCommand(WPARAM hit) {
  if (hit == HTTOPLEFT) {
    return SC_SIZE | WMSZ_TOPLEFT;
  }
  if (hit == HTTOPRIGHT) {
    return SC_SIZE | WMSZ_TOPRIGHT;
  }
  return SC_SIZE | WMSZ_TOP;
}

const wchar_t* ResizeCursor(WPARAM hit) {
  if (hit == HTTOPLEFT) {
    return IDC_SIZENWSE;
  }
  if (hit == HTTOPRIGHT) {
    return IDC_SIZENESW;
  }
  return IDC_SIZENS;
}

}

LRESULT AppWindowHitAt(HWND page, POINT screen) {
  HWND app = page ? ::GetWindow(page, GW_OWNER) : nullptr;
  if (!app) {
    return HTNOWHERE;
  }
  return ::SendMessageW(
      app, WM_NCHITTEST, 0,
      MAKELPARAM(static_cast<short>(screen.x), static_cast<short>(screen.y)));
}

namespace {

HWND HostedPageOf(HWND window) {
  HWND page = window ? ::GetAncestor(window, GA_ROOT) : nullptr;
  return page && ::GetWindow(page, GW_OWNER) && ::GetPropW(page, kHostedPage)
             ? page
             : nullptr;
}

bool PointerOver(HWND page) {
  POINT cursor;
  if (!::GetCursorPos(&cursor)) {
    return true;
  }
  HWND under = ::WindowFromPoint(cursor);
  return under == page || ::IsChild(page, under);
}

}

bool TakeTopEdgePress(const MSG& msg) {
  if (msg.message == WM_NCMOUSELEAVE) {
    HWND page = HostedPageOf(msg.hwnd);
    if (page && msg.hwnd != page && !PointerOver(page)) {
      ::SendMessageW(page, WM_MOUSELEAVE, 0, 0);
    }
    return false;
  }
  if (msg.message != WM_NCMOUSEMOVE && msg.message != WM_NCLBUTTONDOWN &&
      msg.message != WM_NCLBUTTONDBLCLK) {
    return false;
  }
  if (!IsTopEdge(static_cast<LRESULT>(msg.wParam))) {
    return false;
  }
  HWND page = HostedPageOf(msg.hwnd);
  HWND app = page ? ::GetWindow(page, GW_OWNER) : nullptr;
  if (!app) {
    return false;
  }
  if (msg.message == WM_NCMOUSEMOVE) {
    ::SetCursor(::LoadCursorW(nullptr, ResizeCursor(msg.wParam)));
    TRACKMOUSEEVENT leave = {sizeof(leave), TME_LEAVE | TME_NONCLIENT,
                             msg.hwnd, 0};
    ::TrackMouseEvent(&leave);
    return false;
  }
  ::ReleaseCapture();
  if (msg.message == WM_NCLBUTTONDBLCLK) {
    ::SendMessageW(app, WM_NCLBUTTONDBLCLK, msg.wParam, msg.lParam);
    return true;
  }
  ::SendMessageW(app, WM_SYSCOMMAND, SizeCommand(msg.wParam), msg.lParam);
  return true;
}

HostedFrameView::HostedFrameView(BrowserWidget* widget,
                                 BrowserView* browser_view)
    : BrowserFrameView(widget, browser_view) {}

HostedFrameView::~HostedFrameView() = default;

int HostedFrameView::GetTopInset(bool restored) const {
  return 0;
}

void HostedFrameView::UpdateThrobber(bool running) {}

gfx::Rect HostedFrameView::GetBoundsForClientView() const {
  return bounds();
}

gfx::Rect HostedFrameView::GetWindowBoundsForClientBounds(
    const gfx::Rect& client_bounds) const {
  return client_bounds;
}

int HostedFrameView::NonClientHitTest(const gfx::Point& point) {
  HWND page = views::HWNDForWidget(GetWidget());
  if (!page) {
    return HTCLIENT;
  }
  const float scale = display::win::GetScreenWin()->GetScaleFactorForHWND(page);
  POINT screen = {static_cast<LONG>(std::floor(point.x() * scale)),
                  static_cast<LONG>(std::floor(point.y() * scale))};
  ::ClientToScreen(page, &screen);
  ::SetPropW(page, kHostedPage, reinterpret_cast<HANDLE>(1));
  const LRESULT app_hit = AppWindowHitAt(page, screen);
  return IsTopEdge(app_hit) ? static_cast<int>(app_hit) : HTCLIENT;
}

std::unique_ptr<BrowserFrameView> CreateHostedFrameView(
    BrowserWidget* widget,
    BrowserView* browser_view) {
  return std::make_unique<HostedFrameView>(widget, browser_view);
}

BEGIN_METADATA(HostedFrameView)
END_METADATA

}
