// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_WINDOWS_POPUP_WINDOW_H_
#define ARDIA_LINUX_WINDOWS_POPUP_WINDOW_H_

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/observer_list.h"
#include "base/values.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "components/web_modal/web_contents_modal_dialog_host.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_delegate.h"

class Browser;

namespace content {
class WebContents;
}

namespace views {
class WebView;
}

namespace ardia_linux {

class PopupOriginStrip;

class PopupWindow : public views::WidgetDelegate,
                    public content::WebContentsObserver,
                    public TabStripModelObserver,
                    public web_modal::WebContentsModalDialogHost {
 public:
  static constexpr int kOriginStripHeight = 28;

  static void Open(Browser* browser,
                   content::WebContents* contents,
                   const base::DictValue* features,
                   const gfx::Rect& opener_window);
  static PopupWindow* ForBrowser(const Browser* browser);
  static int Count();
  static base::ListValue DebugStates();
  static std::string OriginText(const std::string& url);

  PopupWindow(const PopupWindow&) = delete;
  PopupWindow& operator=(const PopupWindow&) = delete;
  ~PopupWindow() override;

  views::Widget* widget() const { return widget_.get(); }
  content::WebContents* contents() const {
    return content::WebContentsObserver::web_contents();
  }
  bool IsActive() const;
  void Activate();
  void CloseFromUser();
  gfx::Rect PageBoundsInScreen() const;
  base::DictValue DebugState() const;

  bool OnCloseRequested(views::Widget::ClosedReason reason) override;
  views::View* GetInitiallyFocusedView() override;

  void TitleWasSet(content::NavigationEntry* entry) override;
  void PrimaryPageChanged(content::Page& page) override;
  void DidChangeVisibleSecurityState() override;
  void WebContentsDestroyed() override;

  void OnTabStripModelChanged(
      TabStripModel* tab_strip_model,
      const TabStripModelChange& change,
      const TabStripSelectionChange& selection) override;
  void OnTabStripModelDestroyed(TabStripModel* tab_strip_model) override;

  gfx::NativeView GetHostView() const override;
  gfx::Point GetDialogPosition(const gfx::Size& size) override;
  bool ShouldActivateDialog() const override;
  gfx::Size GetMaximumDialogSize() override;
  void AddObserver(web_modal::ModalDialogHostObserver* observer) override;
  void RemoveObserver(web_modal::ModalDialogHostObserver* observer) override;

 private:
  PopupWindow(Browser* browser,
              content::WebContents* contents,
              const gfx::Rect& bounds);

  void ShowFirstTime();
  void OpenAsTab();
  void Describe();
  void LetGoOfPage();
  void Dismiss();

  raw_ptr<Browser> browser_;
  std::unique_ptr<views::Widget> widget_;
  raw_ptr<views::WebView> page_view_ = nullptr;
  raw_ptr<PopupOriginStrip> strip_ = nullptr;
  base::ObserverList<web_modal::ModalDialogHostObserver> modal_observers_;
  bool dismissed_ = false;
  base::WeakPtrFactory<PopupWindow> weak_factory_{this};
};

}

#endif
