#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "Events.h"
#include "MenuKeyboard.h"
#include "MenuPopup.h"
#include "MenuStore.h"
#include "NativeModules.h"
#include "WindowManager.h"

namespace Ardia {

REACT_MODULE(MenusModule, L"ArdiaMenus")
struct MenusModule {
  using JSValue = winrt::Microsoft::ReactNative::JSValue;
  using JSValueObject = winrt::Microsoft::ReactNative::JSValueObject;
  using Promise = winrt::Microsoft::ReactNative::ReactPromise<JSValue>;
  using DonePromise = winrt::Microsoft::ReactNative::ReactPromise<void>;

  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const &context) noexcept {
    m_context = context;
    Menus::MenuKeyboard::Shared().context = context;
    RunOnUI(context, []() noexcept { Menus::MenuKeyboard::Shared().Install(); });
  }

  REACT_METHOD(showMenu)
  void showMenu(JSValue items, Promise promise) noexcept {
    auto parsed = std::make_shared<std::vector<Menus::PopupItem>>(Menus::PopupItemsOf(items));
    RunOnUI(m_context, [context = m_context, parsed, promise]() noexcept {
      try {
        Menus::MenuLog("showMenu asked: " + std::to_string(Menus::VisibleItemCount(*parsed)) + " items");
        if (Menus::TestFlag(L"appMenu")) {
          std::optional<std::string> pick = Menus::TestPick(*parsed);
          promise.Resolve(pick ? JSValue{std::string{*pick}} : JSValue{nullptr});
          return;
        }
        if (WindowManager::Background()) {
          Menus::ReportUnshownMenu(*parsed);
          promise.Resolve(JSValue{nullptr});
          return;
        }
        std::shared_ptr<Menus::Popup> popup = Menus::PreparePopup(*parsed, Menus::MenuOwnerWindow());
        if (!popup) return promise.Resolve(JSValue{nullptr});
        popup->pageLeft = Menus::MenuKeyboard::Shared().PageTheMenuPressLeft(popup->owner);
        bool started = DialogParts::RunModal(popup->owner, [context, popup, promise](bool usable) noexcept {
          if (usable) Menus::TrackOnThisThread(*popup, true);
          if (DialogParts::Stopping()) return;
          RunOnUI(context, [context, popup, promise]() noexcept {
            if (DialogParts::ModalRegistry::Shared().withheldResign.exchange(false) && !Menus::ForegroundIsOurs()) EmitEvent(context, L"ArdiaShell", L"onAppEvent", JSValueObject{{"type", "resignActive"}});
            Menus::MenuKeyboard::Shared().ReconcileAfterMenu();
            std::optional<std::string> chosen = Menus::ChoiceOf(*popup);
            if (popup->pageLeft) Menus::MenuKeyboard::Shared().GivePageBackAfterMenu(*popup->pageLeft, chosen.has_value());
            promise.Resolve(chosen ? JSValue{std::string{*chosen}} : JSValue{nullptr});
          });
        });
        if (!started) {
          Menus::ChoiceOf(*popup);
          promise.Resolve(JSValue{nullptr});
        }
      } catch (...) {
        promise.Resolve(JSValue{nullptr});
      }
    });
  }

  REACT_SYNC_METHOD(openCount)
  int openCount() noexcept {
    return Menus::OpenMenus().load();
  }

  REACT_METHOD(devHoldMenu)
  void devHoldMenu(std::string windowId, bool onUiThread, winrt::Microsoft::ReactNative::ReactPromise<bool> promise) noexcept {
    if (!AppLaunch::Shared().testInstance) return promise.Reject("held menus are for test instances only");
    RunOnUI(m_context, [context = m_context, promise, windowId, onUiThread]() noexcept {
      std::vector<Menus::PopupItem> items(1);
      items[0].id = "held";
      items[0].title = "Self-check: a held menu";
      std::shared_ptr<Menus::Popup> popup = Menus::PreparePopup(items, WindowManager::Shared().Hwnd(windowId));
      if (!popup) return promise.Resolve(false);
      bool foreground = !WindowManager::Background();
      if (onUiThread) {
        Menus::TrackOnThisThread(*popup, foreground);
        return promise.Resolve(Menus::ChoiceOf(*popup).has_value());
      }
      bool started = DialogParts::RunModal(popup->owner, [context, popup, promise, foreground](bool usable) noexcept {
        if (usable) Menus::TrackOnThisThread(*popup, foreground);
        if (DialogParts::Stopping()) return;
        RunOnUI(context, [popup, promise]() noexcept {
          Menus::MenuKeyboard::Shared().ReconcileAfterMenu();
          promise.Resolve(Menus::ChoiceOf(*popup).has_value());
        });
      });
      if (!started) promise.Resolve(Menus::ChoiceOf(*popup).has_value());
    });
  }

  REACT_METHOD(setMenuState)
  void setMenuState(JSValue state, DonePromise promise) noexcept {
    auto shared = std::make_shared<JSValue>(std::move(state));
    RunOnUI(m_context, [shared, promise]() noexcept {
      Menus::MenuStore::Shared().Update(*shared);
      promise.Resolve();
    });
  }

  REACT_METHOD(setMenuBookmarks)
  void setMenuBookmarks(JSValue bookmarks, DonePromise promise) noexcept {
    auto shared = std::make_shared<JSValue>(std::move(bookmarks));
    RunOnUI(m_context, [shared, promise]() noexcept {
      Menus::MenuStore::Shared().UpdateBookmarks(*shared);
      promise.Resolve();
    });
  }

  REACT_METHOD(menuShortcuts)
  void menuShortcuts(Promise promise) noexcept {
    RunOnUI(m_context, [promise]() noexcept { promise.Resolve(Menus::MenuStore::Shared().ShortcutList()); });
  }

  REACT_METHOD(recentMenuLog)
  void recentMenuLog(Promise promise) noexcept {
    RunOnUI(m_context, [promise]() noexcept {
      winrt::Microsoft::ReactNative::JSValueArray lines;
      for (std::string const &line : Menus::RecentMenuLog()) lines.push_back(JSValue{std::string{line}});
      promise.Resolve(JSValue{std::move(lines)});
    });
  }

  REACT_METHOD(activeShortcuts)
  void activeShortcuts(Promise promise) noexcept {
    RunOnUI(m_context, [promise]() noexcept { promise.Resolve(Menus::MenuStore::Shared().ActiveBindings()); });
  }

  REACT_METHOD(recordShortcut)
  void recordShortcut(Promise promise) noexcept {
    RunOnUI(m_context, [promise]() noexcept { Menus::MenuKeyboard::Shared().StartRecording(promise); });
  }

  REACT_METHOD(cancelRecording)
  void cancelRecording(DonePromise promise) noexcept {
    RunOnUI(m_context, [promise]() noexcept {
      Menus::MenuKeyboard::Shared().FinishRecording(JSValue{nullptr});
      promise.Resolve();
    });
  }

 private:
  winrt::Microsoft::ReactNative::ReactContext m_context{nullptr};
};

}
