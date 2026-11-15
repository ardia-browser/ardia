// Copyright 2026 Ardia. Apache-2.0.

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/utf_string_conversions.h"
#include "base/timer/timer.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "content/public/browser/storage_partition.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_buffer.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/native_theme/native_theme.h"
#include "ui/native_theme/native_theme_observer.h"
#include "ui/views/focus/native_view_focus_manager.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaShell";
constexpr char kBangListUrl[] = "https://services.helium.imput.net/bangs.json";
constexpr size_t kMostBangListBytes = 16 << 20;
constexpr base::TimeDelta kResignSettle = base::Milliseconds(50);

constexpr net::NetworkTrafficAnnotationTag kBangListAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_bang_list", R"(
      semantics {
        sender: "Ardia"
        description: "Downloads the list of search shortcuts (bangs)."
        trigger: "The command bar refreshes its bang list."
        data: "None."
        destination: OTHER
      }
      policy {
        cookies_allowed: NO
        setting: "None."
        policy_exception_justification: "Not implemented."
      })");

void EmitAppEvent(base::DictValue payload) {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().Emit(kModule, "onAppEvent",
                               base::Value(std::move(payload)));
  }
}

Profile* OriginalProfile() {
  Profile* profile = ProfileManager::GetLastUsedProfileIfLoaded();
  return profile ? profile->GetOriginalProfile() : nullptr;
}

class Appearance : public ui::NativeThemeObserver,
                   public views::NativeViewFocusChangeListener {
 public:
  static Appearance& Get() {
    static base::NoDestructor<Appearance> appearance;
    return *appearance;
  }

  void Start() {
    if (started_) {
      return;
    }
    started_ = true;
    last_dark_ = Dark();
    observation_.Observe(ui::NativeTheme::GetInstanceForNativeUi());
    views::NativeViewFocusManager::GetInstance()->AddFocusChangeListener(this);
  }

  bool Dark() const {
    if (Profile* profile = OriginalProfile()) {
      switch (ThemeServiceFactory::GetForProfile(profile)
                  ->GetBrowserColorScheme()) {
        case ThemeService::BrowserColorScheme::kLight:
          return false;
        case ThemeService::BrowserColorScheme::kDark:
          return true;
        case ThemeService::BrowserColorScheme::kSystem:
          break;
      }
    }
    return ui::NativeTheme::GetInstanceForNativeUi()->preferred_color_scheme() ==
           ui::NativeTheme::PreferredColorScheme::kDark;
  }

  void Set(const std::string& mode) {
    if (Profile* profile = OriginalProfile()) {
      ThemeServiceFactory::GetForProfile(profile)->SetBrowserColorScheme(
          mode == "light"  ? ThemeService::BrowserColorScheme::kLight
          : mode == "dark" ? ThemeService::BrowserColorScheme::kDark
                           : ThemeService::BrowserColorScheme::kSystem);
    }
    Noticed();
  }

  void OnNativeThemeUpdated(ui::NativeTheme*) override { Noticed(); }

  void OnNativeFocusChanged(gfx::NativeView focused_now) override {
    if (focused_now) {
      resign_.Stop();
      return;
    }
    resign_.Start(FROM_HERE, kResignSettle, base::BindOnce([] {
                    base::DictValue payload;
                    payload.Set("type", "resignActive");
                    EmitAppEvent(std::move(payload));
                  }));
  }

 private:
  friend class base::NoDestructor<Appearance>;
  Appearance() = default;

  void Noticed() {
    const bool dark = Dark();
    if (last_dark_ && *last_dark_ == dark) {
      return;
    }
    last_dark_ = dark;
    base::DictValue payload;
    payload.Set("type", "appearance");
    payload.Set("dark", dark);
    EmitAppEvent(std::move(payload));
  }

  bool started_ = false;
  std::optional<bool> last_dark_;
  base::OneShotTimer resign_;
  base::ScopedObservation<ui::NativeTheme, ui::NativeThemeObserver>
      observation_{this};
};

void FetchBangList(base::ListValue args, ModuleReply reply) {
  Profile* profile = OriginalProfile();
  if (!profile) {
    std::move(reply).Run(ModuleFailure("no profile is loaded yet"));
    return;
  }
  const std::string override_url = CurrentLaunchConfig().TestValue("bangsUrl");
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(override_url.empty() ? kBangListUrl : override_url);
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->load_flags = net::LOAD_BYPASS_CACHE | net::LOAD_DISABLE_CACHE;
  if (std::optional<std::string> etag = OptionalStringArg(args, 0);
      etag && !etag->empty()) {
    request->headers.SetHeader("If-None-Match", *etag);
  }
  std::unique_ptr<network::SimpleURLLoader> loader =
      network::SimpleURLLoader::Create(std::move(request),
                                       kBangListAnnotation);
  loader->SetAllowHttpErrorResults(true);
  network::SimpleURLLoader* raw = loader.get();
  raw->DownloadToString(
      profile->GetDefaultStoragePartition()
          ->GetURLLoaderFactoryForBrowserProcess()
          .get(),
      base::BindOnce(
          [](std::unique_ptr<network::SimpleURLLoader> loader,
             ModuleReply reply, std::optional<std::string> body) {
            const network::mojom::URLResponseHead* head =
                loader->ResponseInfo();
            if (!head || !head->headers) {
              std::move(reply).Run(ModuleFailure(
                  net::ErrorToString(loader->NetError()), "ERR_LINUX_NET"));
              return;
            }
            const int status = head->headers->response_code();
            base::DictValue result;
            result.Set("status", status);
            std::optional<std::string> etag =
                head->headers->GetNormalizedHeader("etag");
            result.Set("etag", OrNull(std::move(etag)));
            result.Set("contentType",
                       OrNull(head->headers->GetNormalizedHeader(
                           "content-type")));
            if (status == 200 && body) {
              result.Set("bytes", static_cast<int>(body->size()));
              result.Set("body", std::move(*body));
            } else {
              result.Set("body", base::Value());
              result.Set("bytes", 0);
            }
            std::move(reply).Run(base::Value(std::move(result)));
          },
          std::move(loader), std::move(reply)),
      kMostBangListBytes);
}

}

void RegisterShellModule(ModuleRegistry& registry) {
  Appearance::Get().Start();
  registry.Define(kModule)
      .Sync("copyText", SyncOf([](const base::ListValue& args) {
              ui::ScopedClipboardWriter(ui::ClipboardBuffer::kCopyPaste)
                  .WriteText(base::UTF8ToUTF16(StringArg(args, 0)));
              return ModuleResult(base::Value(true));
            }))
      .Sync("startDictation", SyncOf([](const base::ListValue&) {
              Note("shell", "dictation isn't on Linux");
              return ModuleResult(base::Value());
            }))
      .Async("setAppearance", AnswerOf([](const base::ListValue& args) {
               Appearance::Get().Set(StringArg(args, 0));
               return ModuleResult(base::Value());
             }))
      .Async("isDarkAppearance", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(Appearance::Get().Dark()));
             }))
      .Async("readText", AsyncOf([](base::ListValue, ModuleReply reply) {
               ui::Clipboard::GetForCurrentThread()->ReadText(
                   ui::ClipboardBuffer::kCopyPaste, std::nullopt,
                   base::BindOnce(
                       [](ModuleReply reply, std::u16string text) {
                         std::move(reply).Run(
                             base::Value(base::UTF16ToUTF8(text)));
                       },
                       std::move(reply)));
             }))
      .Async("fetchBangList", base::BindRepeating(&FetchBangList));
}

}
