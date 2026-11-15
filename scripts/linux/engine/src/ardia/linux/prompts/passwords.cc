// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>

#include "ardia/core/ac_hooks.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"
#include "ardia/win/profiles.h"
#include "ardia/win/tab_state.h"
#include "base/memory/weak_ptr.h"
#include "base/functional/bind.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/passwords/passwords_model_delegate.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_string.h"
#include "components/password_manager/core/common/password_manager_pref_names.h"
#include "components/password_manager/core/common/password_manager_ui.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

using password_manager::ui::State;

constexpr int kMostOpenerHops = 8;

class PasswordPromptRoute
    : public content::WebContentsUserData<PasswordPromptRoute> {
 public:
  ~PasswordPromptRoute() override = default;

  static void Note(content::WebContents* shown_in,
                   content::WebContents* source) {
    if (!source) {
      shown_in->RemoveUserData(UserDataKey());
      return;
    }
    CreateForWebContents(shown_in);
    FromWebContents(shown_in)->source_ = source->GetWeakPtr();
  }

  static content::WebContents* Take(content::WebContents* shown_in,
                                    bool* routed) {
    PasswordPromptRoute* route = FromWebContents(shown_in);
    *routed = route != nullptr;
    if (!route) {
      return shown_in;
    }
    base::WeakPtr<content::WebContents> source = route->source_;
    shown_in->RemoveUserData(UserDataKey());
    return source.get();
  }

 private:
  explicit PasswordPromptRoute(content::WebContents* contents)
      : content::WebContentsUserData<PasswordPromptRoute>(*contents) {}
  friend WebContentsUserData;
  WEB_CONTENTS_USER_DATA_KEY_DECL();

  base::WeakPtr<content::WebContents> source_;
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(PasswordPromptRoute);

ardia_win::TabState* KeyedTab(content::WebContents* contents) {
  ardia_win::TabState* tab =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return tab && !tab->key().empty() ? tab : nullptr;
}

content::WebContents* TabShowingPromptOf(content::WebContents* contents) {
  content::WebContents* candidate = contents;
  for (int hop = 0; candidate && hop <= kMostOpenerHops; ++hop) {
    if (KeyedTab(candidate)) {
      return candidate;
    }
    content::WebContents* opener =
        candidate->GetFirstWebContentsInLiveOriginalOpenerChain();
    candidate = opener == candidate ? nullptr : opener;
  }
  return nullptr;
}

base::WeakPtr<PasswordsModelDelegate> ModelFor(content::WebContents* contents) {
  return contents ? PasswordsModelDelegateFromWebContents(contents) : nullptr;
}

std::optional<base::DictValue> PasswordPrompt(content::WebContents* contents) {
  base::WeakPtr<PasswordsModelDelegate> model = ModelFor(contents);
  if (!model) {
    return std::nullopt;
  }
  const State state = model->GetState();
  const char* name = nullptr;
  switch (state) {
    case State::PENDING_PASSWORD_STATE:
      name = "save";
      break;
    case State::PENDING_PASSWORD_UPDATE_STATE:
      name = "update";
      break;
    case State::SAVE_CONFIRMATION_STATE:
    case State::UPDATE_CONFIRMATION_STATE:
      name = "saved";
      break;
    default:
      return std::nullopt;
  }
  std::string username;
  size_t length = 0;
  std::string federation;
  if (state != State::UPDATE_CONFIRMATION_STATE) {
    const password_manager::PasswordForm& form = model->GetPendingPassword();
    username = base::UTF16ToUTF8(form.username_value);
    length = form.password_value.size();
    if (form.federation_origin.IsValid()) {
      federation = form.federation_origin.Serialize();
    }
  }
  base::ListValue usernames;
  for (const auto& form : model->GetCurrentForms()) {
    if (form && !form->username_value.empty()) {
      usernames.Append(base::UTF16ToUTF8(form->username_value));
    }
  }
  base::DictValue prompt;
  prompt.Set("state", name);
  prompt.Set("origin", model->GetOrigin().Serialize());
  prompt.Set("username", username);
  prompt.Set("passwordLength", static_cast<int>(length));
  prompt.Set("federation", federation);
  prompt.Set("usernames", std::move(usernames));
  return prompt;
}

bool OfferPasswordSave(content::WebContents* contents) {
  content::WebContents* shown_in = TabShowingPromptOf(contents);
  ardia_win::TabState* tab = KeyedTab(shown_in);
  if (!tab) {
    return false;
  }
  std::optional<base::DictValue> prompt = PasswordPrompt(contents);
  if (!prompt) {
    return false;
  }
  if (base::WeakPtr<PasswordsModelDelegate> model = ModelFor(contents)) {
    model->OnBubbleShown();
  }
  const bool from_popup = shown_in != contents;
  const std::string* state = prompt->FindString("state");
  const bool saved = state && *state == "saved";
  CountLinux(saved ? "passwordSavedNotices" : "passwordPrompts");
  if (from_popup && !saved) {
    CountLinux("passwordPromptsFromPopups");
  }
  PasswordPromptRoute::Note(shown_in, from_popup ? contents : nullptr);
  tab->Send("passwordPrompt", std::move(*prompt));
  base::WeakPtr<PasswordsModelDelegate> model = ModelFor(contents);
  if (model && (model->GetState() == State::SAVE_CONFIRMATION_STATE ||
                model->GetState() == State::UPDATE_CONFIRMATION_STATE)) {
    model->OnBubbleHidden();
  }
  return true;
}

void ResolvePasswordPrompt(content::WebContents* contents,
                           const std::string& action,
                           const std::string& username,
                           const std::string& password) {
  base::WeakPtr<PasswordsModelDelegate> model = ModelFor(contents);
  if (!model) {
    return;
  }
  const State state = model->GetState();
  const bool offers_save = state == State::PENDING_PASSWORD_STATE ||
                           state == State::PENDING_PASSWORD_UPDATE_STATE;
  if (((action == "save" || action == "update") && !offers_save) ||
      (action == "never" && state != State::PENDING_PASSWORD_STATE) ||
      (action == "nope" && state != State::PENDING_PASSWORD_UPDATE_STATE)) {
    return;
  }
  if (action == "save" || action == "update") {
    const password_manager::PasswordForm& pending = model->GetPendingPassword();
    model->SavePassword(
        username.empty() ? pending.username_value
                         : base::UTF8ToUTF16(username),
        password.empty()
            ? pending.password_value
            : password_manager::PasswordString(base::UTF8ToUTF16(password)));
    CountLinux("passwordPromptSaves");
  } else if (action == "never") {
    model->NeverSavePassword();
  } else if (action == "nope") {
    model->OnNopeUpdateClicked();
  } else if (action != "dismiss") {
    return;
  }
  if (model) {
    model->OnBubbleHidden();
  }
}

std::string Field(const base::DictValue& args, const char* key) {
  const std::string* text = args.FindString(key);
  return text ? *text : std::string();
}

void OfferingVerb(const std::string& profile,
                  base::DictValue args,
                  ModuleReply reply) {
  ardia_win::WithProfile(
      profile, base::BindOnce(
                   [](ModuleReply reply, Profile* profile) {
                     if (!profile) {
                       ReplyError(std::move(reply), "no such profile");
                       return;
                     }
                     ReplyJson(std::move(reply),
                               base::Value(profile->GetPrefs()->GetBoolean(
                                   password_manager::prefs::
                                       kCredentialsEnableService)));
                   },
                   std::move(reply)));
}

void SetOfferingVerb(const std::string& profile,
                     base::DictValue args,
                     ModuleReply reply) {
  const std::optional<bool> enabled = args.FindBool("enabled");
  if (!enabled) {
    ReplyError(std::move(reply), "enabled must be a boolean");
    return;
  }
  ardia_win::WithProfile(
      profile, base::BindOnce(
                   [](bool enabled, ModuleReply reply, Profile* profile) {
                     if (!profile) {
                       ReplyError(std::move(reply), "no such profile");
                       return;
                     }
                     profile->GetPrefs()->SetBoolean(
                         password_manager::prefs::kCredentialsEnableService,
                         enabled);
                     ReplyNull(std::move(reply));
                   },
                   *enabled, std::move(reply)));
}

}

void AddPasswordVerbs(DomainVerbs& verbs) {
  verbs.Add("passwords", "autofillEnabled", base::BindRepeating(&OfferingVerb));
  verbs.Add("passwords", "setAutofillEnabled",
            base::BindRepeating(&SetOfferingVerb));
}

void InstallPasswordPrompts() {
  g_ardia_password_bubble = &OfferPasswordSave;
}

bool CallPasswordMethod(content::WebContents* contents,
                        const std::string& method,
                        const base::DictValue& args,
                        ardia_win::Reply& reply) {
  if (method != "resolvePasswordPrompt") {
    return false;
  }
  const base::DictValue* edits = args.FindDict("edits");
  bool routed = false;
  content::WebContents* source = PasswordPromptRoute::Take(contents, &routed);
  if (routed && !source) {
    CountLinux("passwordPromptsPopupGone");
  }
  ResolvePasswordPrompt(source, Field(args, "answer"),
                        edits ? Field(*edits, "username") : std::string(),
                        edits ? Field(*edits, "password") : std::string());
  base::DictValue done;
  done.Set("ok", true);
  std::move(reply).Run(std::move(done));
  return true;
}

}
