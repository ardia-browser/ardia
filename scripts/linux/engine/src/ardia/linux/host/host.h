// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_HOST_HOST_H_
#define ARDIA_LINUX_HOST_HOST_H_

#include <map>
#include <optional>
#include <set>
#include <string>

#include "ardia/win/api.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/values.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "ui/gfx/geometry/rect.h"

class Browser;
class BrowserWindow;
class BrowserWindowInterface;
class Profile;

namespace content {
class WebContents;
}

namespace ui {
class MouseEvent;
}

namespace ardia_win {
class TabState;
}

namespace ardia_linux {

class Host : public TabStripModelObserver, public BrowserCollectionObserver {
 public:
  Host(const Host&) = delete;
  Host& operator=(const Host&) = delete;

  static Host* Get();

  void Start();
  void Call(const std::string& verb,
            base::DictValue args,
            const std::string& window,
            ardia_win::Reply reply);

  bool Keeps(const BrowserWindowInterface* browser) const;
  BrowserWindow* HostChromeBrowser(Browser* browser);
  int BrowsersOf(Profile* profile) const;
  int CloseBrowsersOf(Profile* profile);
  void ForgetProfile(Profile* profile);
  bool Shows(const std::string& key) const;
  void TabDestroyed(ardia_win::TabState* state);
  void DeleteClosedTab(content::WebContents* contents);

  std::string WindowOfBrowser(const Browser* browser) const;
  std::string WindowOfContents(content::WebContents* contents) const;
  std::optional<gfx::Rect> PlaceOf(content::WebContents* contents) const;
  void WindowClosing(const std::string& window);
  void WindowActivated(const std::string& window);
  void DevToolsDockChanged(content::WebContents* inspected,
                           content::WebContents* devtools);
  void WindowMoved(const std::string& window);
  void WindowFullscreenChanged(const std::string& window);
  void PagePressed(const std::string& window, const std::string& key);
  void PageMouse(const std::string& window,
                 const std::string& key,
                 const ui::MouseEvent& event);
  void BrowserWindowGone(Browser* browser);

  void OnTabStripModelChanged(
      TabStripModel* tab_strip_model,
      const TabStripModelChange& change,
      const TabStripSelectionChange& selection) override;

  void OnBrowserCreated(BrowserWindowInterface* browser) override;
  void OnBrowserClosed(BrowserWindowInterface* browser) override;

 private:
  friend class base::NoDestructor<Host>;

  struct Hosted {
    std::string window;
    raw_ptr<Profile> profile = nullptr;
  };

  struct Shown {
    std::string window;
    gfx::Rect place;
  };

  Host();
  ~Host() override;

  void CreateTab(base::DictValue args,
                 const std::string& window,
                 ardia_win::Reply reply);
  void CreateExtensionViewInProfile(std::string key,
                                    std::string url,
                                    std::string kind,
                                    std::string window,
                                    ardia_win::Reply reply,
                                    Profile* profile);
  void CreateTabInProfile(std::string key,
                          std::string url,
                          std::string profile_name,
                          std::string window,
                          ardia_win::Reply reply,
                          Profile* profile);
  base::DictValue ShowTab(const base::DictValue& args,
                          const std::string& window);
  base::DictValue CloseTab(const base::DictValue& args);
  std::optional<base::DictValue> CallTab(content::WebContents* contents,
                                         const base::DictValue& args);
  base::DictValue DiscardOffered(const base::DictValue& args);
  base::DictValue Info();
  base::DictValue ListTabs();

  content::WebContents* Find(const std::string& key) const;
  content::WebContents* FindOffered(const std::string& adopt) const;
  Browser* BrowserFor(const std::string& window, Profile* profile);
  Browser* NewBrowser(const std::string& window, Profile* profile);
  Browser* BrowserOf(content::WebContents* contents) const;
  Browser* OwnerOf(const TabStripModel* model) const;
  bool PlaceTab(content::WebContents* contents, const std::string& window);
  bool MoveTab(content::WebContents* contents, Browser* from, Browser* target);
  void HideTab(const std::string& key);
  void GiveKeyboard(content::WebContents* contents,
                    const std::string& window,
                    bool follow,
                    bool background);
  void ApplyWantedKeyboard(const std::string& window);
  void KeyboardToWindowIfUnfocused(const std::string& window);
  std::string KeyboardPage() const;
  void CloseSpareBrowsers();
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

  std::map<Browser*, Hosted> hosted_;
  std::set<Browser*> foreign_;
  std::map<std::string, raw_ptr<content::WebContents>> tabs_;
  std::map<std::string, Shown> shown_;
  std::map<Profile*, std::string> profile_names_;
  std::map<std::string, std::string> keyboard_wanted_;
  bool creating_tab_ = false;
  bool moving_tab_ = false;
  bool started_ = false;
  base::ScopedObservation<GlobalBrowserCollection, BrowserCollectionObserver>
      browsers_observation_{this};
  base::WeakPtrFactory<Host> weak_factory_{this};
};

}

#endif
