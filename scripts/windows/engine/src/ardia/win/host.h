#ifndef ARDIA_WIN_HOST_H_
#define ARDIA_WIN_HOST_H_

#include <windows.h>

#include <map>
#include <optional>
#include <set>
#include <string>

#include "ardia/win/api.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/extensions/extension_popup_types.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "ui/base/window_open_disposition.h"
#include "ui/events/event_handler.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/views/view_tracker.h"

class Browser;
class BrowserWindowInterface;

namespace extensions {
class Extension;
}

namespace blink::mojom {
class WindowFeatures;
}
class Profile;

namespace content {
class WebContents;
}

namespace ardia_win {

class TabState;

class Host : public TabStripModelObserver,
             public BrowserCollectionObserver,
             public ui::EventHandler {
 public:
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;

  static Host* Get();

  void Start();
  void Call(const std::string& verb,
            base::DictValue args,
            HWND window,
            Reply reply);
  bool Keeps(const BrowserWindowInterface* browser) const;
  int BrowsersOf(Profile* profile) const;
  int CloseBrowsersOf(Profile* profile);
  void ForgetProfile(Profile* profile);
  bool Shows(const std::string& key) const;
  bool OpensLivePage(const content::WebContents* contents) const;
  HWND VisibleParent() const;
  void TabDestroyed(TabState* state);
  void DeleteClosedTab(content::WebContents* contents);
  void ParentDestroying(HWND parent);
  void ParentMoved(HWND parent);
  void ParentActivated(HWND parent, HWND previous);
  BrowserWindowInterface* ActiveExtensionBrowser(Profile& profile,
                                                 bool include_incognito) const;
  std::optional<bool> ExtensionBrowserActive(BrowserWindowInterface& browser) const;
  std::optional<bool> OpenExtensionPopupFromApi(
      BrowserWindowInterface& browser,
      const extensions::Extension& extension,
      ShowPopupCallback& callback);
  bool HandOverWindowCommand(HWND window, WPARAM command, LPARAM point);
  void HoldPagePlace(HWND window, WINDOWPOS& change);
  void PageMoved(HWND window, const WINDOWPOS& change);
  void PageDestroyed(HWND window);
  bool OpenAsOffer(BrowserWindowInterface* browser,
                   WindowOpenDisposition disposition,
                   const blink::mojom::WindowFeatures& features);
  void OfferInserted();

  void OnTabStripModelChanged(
      TabStripModel* tab_strip_model,
      const TabStripModelChange& change,
      const TabStripSelectionChange& selection) override;

  void OnBrowserCreated(BrowserWindowInterface* browser) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;

  void OnMouseEvent(ui::MouseEvent* event) override;
  void OnTouchEvent(ui::TouchEvent* event) override;

 private:
  friend class base::NoDestructor<Host>;

  struct Hosted {
    HWND parent = nullptr;
    raw_ptr<Profile> profile = nullptr;
    std::string shown;
    gfx::Rect place;
    views::ViewTracker extension_popup_anchor;
  };

  struct ExtensionToolbar {
    std::string selected;
    base::DictValue anchors;
    gfx::Size client_size;
  };

  Host();
  ~Host() override;

  void CreateTab(base::DictValue args, HWND parent, Reply reply);
  void CreateTabInProfile(std::string key,
                          std::string url,
                          std::string profile_name,
                          HWND parent,
                          Reply reply,
                          Profile* profile);
  base::DictValue ShowTab(const base::DictValue& args, HWND parent);
  base::DictValue CloseTab(const base::DictValue& args);
  std::optional<base::DictValue> CallTab(content::WebContents* contents,
                                         const base::DictValue& args);
  base::DictValue RunExtensionAction(content::WebContents* contents,
                                     HWND parent,
                                     const base::DictValue& args);
  Browser* ForegroundHostedPage() const;
  void UpdateExtensionToolbar(HWND parent, const base::DictValue& args);
  void ShellPressed(HWND parent, const base::DictValue& args);
  base::DictValue DiscardOffered(const base::DictValue& args);
  base::DictValue HitTest(const base::DictValue& args);
  base::DictValue MoveWindowForTest(content::WebContents* contents,
                                    const base::DictValue& args);
  base::DictValue Info();
  base::DictValue ListTabs();

  content::WebContents* Find(const std::string& key) const;
  content::WebContents* FindOffered(const std::string& adopt) const;
  Browser* BrowserFor(HWND parent, Profile* profile);
  Browser* FreePageFor(HWND parent, Profile* profile, const Browser* except);
  Browser* NewPage(HWND parent, Profile* profile);
  bool Fits(const Hosted& hosted, HWND parent, const std::string& key) const;
  bool MoveTab(content::WebContents* contents, Browser* from, Browser* target);
  Browser* BrowserOf(content::WebContents* contents) const;
  Browser* OwnerOf(const TabStripModel* model) const;
  bool PlaceTab(content::WebContents* contents, HWND parent);
  void Adopt(Browser* browser);
  void Park(Browser* browser);
  void ParkForeign(base::WeakPtr<BrowserWindowInterface> browser);
  void Hide(Browser* browser, Hosted& hosted);
  void GiveKeyboard(Browser* browser,
                    content::WebContents* contents,
                    bool follow,
                    bool background);
  void ApplyWantedKeyboard(HWND parent);
  std::string KeyboardPage() const;
  void CloseSparePages();
  void NoteOffer(content::WebContents* contents, HWND parent);
  void ExpireOffer(int id);
  void CloseOffered(content::WebContents* contents);
  void Place(HWND window, const Hosted& hosted);
  void WatchParent(HWND parent);
  void FocusFor(ui::Event* event);
  std::string PageKeyFor(ui::Event* event) const;
  void EmitOpened(base::DictValue payload,
                  base::WeakPtr<content::WebContents> contents,
                  std::string opener_key,
                  int tries);
  void NoteOpened(Browser* browser,
                  TabStripModel* model,
                  content::WebContents* contents,
                  int index,
                  bool foreground);
  std::string NameOf(Profile* profile) const;
  HWND ShownParentOf(HWND window);
  void PutBack(HWND window);
  void FullscreenLeft(HWND window);

  std::map<Browser*, Hosted> hosted_;
  std::set<Browser*> popup_browsers_;
  struct Opening {
    raw_ptr<Browser> browser = nullptr;
    bool popup = false;
    base::DictValue bounds;
  };
  struct Offer {
    base::WeakPtr<content::WebContents> contents;
    HWND parent = nullptr;
    bool heard = false;
  };
  Opening opening_;
  std::map<int, Offer> offers_;
  std::set<Browser*> foreign_;
  std::map<std::string, raw_ptr<content::WebContents>> tabs_;
  std::map<Profile*, std::string> profile_names_;
  std::set<HWND> parents_;
  std::map<HWND, ExtensionToolbar> extension_toolbars_;
  std::map<HWND, std::string> keyboard_wanted_;
  std::set<HWND> fullscreen_pages_;
  std::set<HWND> leaving_fullscreen_;
  std::set<HWND> put_back_pending_;
  bool placing_ = false;
  bool creating_browser_ = false;
  bool creating_tab_ = false;
  bool moving_tab_ = false;
  bool started_ = false;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      browsers_observation_{this};
  base::WeakPtrFactory<Host> weak_factory_{this};
};

}

#endif
