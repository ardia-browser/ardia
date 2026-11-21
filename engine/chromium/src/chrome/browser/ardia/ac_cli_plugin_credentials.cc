// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_plugin_refusals.h"
#include "base/base64url.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/containers/span.h"
#include "base/no_destructor.h"
#include "base/rand_util.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_visible_tabs.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_collection_observer.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "components/sessions/core/session_id.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/web_contents.h"
#include "crypto/secure_util.h"

namespace ardia {
namespace {

constexpr size_t kSecretBytes = 32;
constexpr size_t kMaxPerProfile = 16;

struct Credential {
  std::string secret;
  PluginScope scope;
};

std::map<std::string, Credential>& Credentials() {
  static base::NoDestructor<std::map<std::string, Credential>> credentials;
  return *credentials;
}

bool WindowAlive(const PluginScope& scope) {
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithID(
          SessionID::FromSerializedValue(scope.window));
  Profile* profile = browser ? browser->GetProfile() : nullptr;
  return profile && profile->GetPath() == scope.profile &&
         profile->IsOffTheRecord() == scope.off_the_record;
}

void SweepDeadCredentials() {
  std::vector<std::string> dead;
  for (const auto& [id, credential] : Credentials()) {
    if (!WindowAlive(credential.scope)) {
      dead.push_back(id);
    }
  }
  for (const std::string& id : dead) {
    RevokePluginCredential(id);
  }
}

class SweepOnWindowClose : public BrowserCollectionObserver {
 public:
  void Watch() {
    if (!observation_.IsObserving()) {
      observation_.Observe(GlobalBrowserCollection::GetInstance());
    }
  }

  void OnBrowserClosed(BrowserWindowInterface* browser) override {
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(&SweepDeadCredentials));
  }

 private:
  base::ScopedObservation<BrowserCollection, BrowserCollectionObserver>
      observation_{this};
};

void WatchWindowCloses() {
  static base::NoDestructor<SweepOnWindowClose> sweep;
  sweep->Watch();
}

std::string RandomText(size_t bytes) {
  std::string text;
  base::Base64UrlEncode(base::RandBytesAsVector(bytes),
                        base::Base64UrlEncodePolicy::OMIT_PADDING, &text);
  return text;
}

}

std::optional<MintedPluginCredential> MintPluginCredential(PluginScope scope) {
  SweepDeadCredentials();
  WatchWindowCloses();
  size_t in_profile = 0;
  for (const auto& [id, credential] : Credentials()) {
    in_profile += credential.scope.profile == scope.profile &&
                  credential.scope.off_the_record == scope.off_the_record;
  }
  if (in_profile >= kMaxPerProfile) {
    return std::nullopt;
  }
  MintedPluginCredential minted;
  do {
    minted.id = "plugin-" + base::HexEncode(base::RandBytesAsVector(8));
  } while (Credentials().contains(minted.id));
  minted.secret = "p." + RandomText(kSecretBytes);
  scope.credential_id = minted.id;
  Credentials()[minted.id] = Credential{minted.secret, std::move(scope)};
  ++PluginTotalsSoFar().minted;
  return minted;
}

bool RevokePluginCredential(const std::string& id) {
  if (!Credentials().erase(id)) {
    return false;
  }
  ++PluginTotalsSoFar().revoked;
  CloseTokenClientsOf(id);
  return true;
}

bool PluginCredentialLive(const std::string& id) {
  auto it = Credentials().find(id);
  if (it == Credentials().end()) {
    return false;
  }
  if (WindowAlive(it->second.scope)) {
    return true;
  }
  RevokePluginCredential(id);
  return false;
}

void ClearPluginCredentials() {
  std::vector<std::string> ids;
  for (const auto& [id, credential] : Credentials()) {
    ids.push_back(id);
  }
  for (const std::string& id : ids) {
    RevokePluginCredential(id);
  }
}

std::optional<PluginScope> PluginScopeForId(const std::string& id) {
  if (!PluginCredentialLive(id)) {
    return std::nullopt;
  }
  return Credentials().at(id).scope;
}

std::optional<PluginScope> PluginScopeForSecret(std::string_view secret) {
  SweepDeadCredentials();
  std::optional<PluginScope> found;
  for (const auto& [id, credential] : Credentials()) {
    if (credential.secret.size() == secret.size() &&
        crypto::SecureMemEqual(base::as_byte_span(credential.secret),
                               base::as_byte_span(secret))) {
      found = credential.scope;
    }
  }
  return found;
}

}

AC_ARGS_CALL(ac_cli_plugin_credential) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  if (const std::string* revoke = args.FindString("revoke")) {
    return out.Send(base::DictValue().Set(
        "revoked", ardia::RevokePluginCredential(*revoke)));
  }
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (std::optional<bool> visible = args.FindBool("visible")) {
    const std::string* id = args.FindString("id");
    if (!id) {
      return out.Error(ardia::refusal::kHoldNoCredential);
    }
    if (!contents) {
      return *visible ? out.Error(ardia::refusal::kNoSuchTab)
                      : out.Send(base::DictValue().Set("visible", false));
    }
    switch (ardia::SetPluginTabVisibleHold(*id, contents, *visible)) {
      case ardia::PluginTabHold::kOk:
        return out.Send(base::DictValue().Set("visible", *visible));
      case ardia::PluginTabHold::kNoCredential:
        return out.Error(ardia::refusal::kHoldNoCredential);
      case ardia::PluginTabHold::kOutOfScope:
        return out.Error(ardia::refusal::kHoldOutOfScope);
      case ardia::PluginTabHold::kNoSession:
        return out.Error(ardia::refusal::kHoldNoAttachedSession);
      case ardia::PluginTabHold::kInProgress:
        return out.Error(ardia::refusal::kHoldInProgress);
    }
  }
  BrowserWindowInterface* browser =
      contents
          ? GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents)
          : nullptr;
  Profile* profile = browser ? browser->GetProfile() : nullptr;
  if (!profile) {
    return out.Error(ardia::refusal::kNoSuchTab);
  }
  ardia::PluginScope scope;
  scope.window = browser->GetSessionID().id();
  scope.profile = profile->GetPath();
  scope.off_the_record = profile->IsOffTheRecord();
  const std::optional<ardia::MintedPluginCredential> minted =
      ardia::MintPluginCredential(std::move(scope));
  if (!minted) {
    return out.Error(ardia::refusal::kTooManyCredentials);
  }
  out.Send(base::DictValue()
               .Set("id", minted->id)
               .Set("credential", minted->secret)
               .Set("window", browser->GetSessionID().id())
               .Set("endpoint", ardia::TokenServerEndpoint()));
}
