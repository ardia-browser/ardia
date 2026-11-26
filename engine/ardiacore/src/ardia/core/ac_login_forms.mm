#include "ardia/core/ac_login_forms.h"

#include <algorithm>
#include <initializer_list>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/containers/flat_set.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/password_manager/chrome_password_manager_client.h"
#include "components/autofill/content/browser/content_autofill_client.h"
#include "components/autofill/content/browser/content_autofill_driver.h"
#include "components/autofill/core/browser/autofill_field.h"
#include "components/autofill/core/browser/field_types.h"
#include "components/autofill/core/browser/form_structure.h"
#include "components/autofill/core/common/signatures.h"
#include "components/autofill/core/browser/foundations/autofill_manager.h"
#include "components/autofill/core/browser/foundations/scoped_autofill_managers_observation.h"
#include "components/password_manager/content/browser/content_password_manager_driver.h"
#include "components/password_manager/core/browser/form_parsing/form_data_parser.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_form_cache.h"
#include "components/password_manager/core/browser/password_form_manager.h"
#include "components/password_manager/core/browser/password_manager_interface.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ardia/core/ac_browser.h"
#import "ardia/core/ardiacore_internal.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace ardiacore {

namespace {

using autofill::AutofillField;
using autofill::AutofillManager;
using autofill::FormGlobalId;
using autofill::FormStructure;
using password_manager::PasswordForm;
using password_manager::PasswordFormManager;

content::RenderFrameHost* FrameOf(password_manager::PasswordManagerDriver* driver) {
  auto* content_driver =
      static_cast<password_manager::ContentPasswordManagerDriver*>(driver);
  return content_driver ? content_driver->render_frame_host() : nullptr;
}

bool AncestorsShareOrigin(content::RenderFrameHost* frame) {
  const url::Origin& origin = frame->GetLastCommittedOrigin();
  for (content::RenderFrameHost* parent = frame->GetParent(); parent;
       parent = parent->GetParent()) {
    if (!parent->GetLastCommittedOrigin().IsSameOriginWith(origin)) {
      return false;
    }
  }
  return true;
}

bool IsOneTimeCode(const AutofillField& field) {
  return field.html_type() == autofill::HtmlFieldType::kOneTimeCode ||
         field.Type().GetTypes().contains(autofill::ONE_TIME_CODE);
}

bool IsUsernameLike(const AutofillField& field) {
  const autofill::FieldTypeSet types = field.Type().GetTypes();
  return field.html_type() == autofill::HtmlFieldType::kEmail ||
         types.contains(autofill::USERNAME) ||
         types.contains(autofill::USERNAME_AND_EMAIL_ADDRESS) ||
         types.contains(autofill::SINGLE_USERNAME) ||
         types.contains(autofill::EMAIL_ADDRESS);
}

bool IsPasswordField(const AutofillField& field) {
  return field.form_control_type() == autofill::FormControlType::kInputPassword;
}

content::RenderFrameHost* FrameWithToken(
    content::RenderFrameHost* root,
    const autofill::LocalFrameToken& token) {
  if (autofill::LocalFrameToken(root->GetFrameToken().value()) == token) {
    return root;
  }
  content::RenderFrameHost* found = nullptr;
  root->ForEachRenderFrameHost([&](content::RenderFrameHost* frame) {
    if (!found &&
        autofill::LocalFrameToken(frame->GetFrameToken().value()) == token) {
      found = frame;
    }
  });
  return found;
}

std::string Letters(std::u16string_view text) {
  std::string letters;
  for (char16_t c : text) {
    if (base::IsAsciiAlpha(c)) {
      letters.push_back(base::ToLowerASCII(static_cast<char>(c)));
    }
  }
  return letters;
}

bool HasAnyWord(const std::string& letters,
                std::initializer_list<std::string_view> words) {
  return std::ranges::any_of(words, [&](std::string_view word) {
    return letters.find(word) != std::string::npos;
  });
}

bool ReadsAsSignUp(const autofill::ButtonTitleList& titles,
                   std::u16string_view id,
                   std::u16string_view name) {
  bool reset = false;
  bool sign_up = false;
  bool button_signs_in = false;
  auto read = [&](std::u16string_view text, bool button) {
    const std::string letters = Letters(text);
    reset |= HasAnyWord(letters, {"reset", "newpassword", "changepassword",
                                  "forgotpassword", "setpassword",
                                  "updatepassword", "choosepassword"});
    sign_up |= HasAnyWord(letters, {"signup", "register", "createaccount",
                                    "createanaccount", "createmyaccount",
                                    "createyouraccount", "joinnow",
                                    "getstarted"});
    button_signs_in |=
        button && HasAnyWord(letters, {"signin", "login", "logon", "signon"});
  };
  for (const autofill::ButtonTitleInfo& title : titles) {
    read(title.first, true);
  }
  read(id, false);
  read(name, false);
  return reset || (sign_up && !button_signs_in);
}

bool MarkedNewPassword(const autofill::FormFieldData& field) {
  return field.autocomplete_attribute().find("new-password") !=
         std::string::npos;
}

bool IsTextLike(const autofill::FormFieldData& field) {
  return field.IsTextInputElement() &&
         field.form_control_type() != autofill::FormControlType::kInputPassword;
}

struct PieceFacts {
  int passwords = 0;
  bool new_password = false;
  autofill::FieldRendererId text_before_password;
};

bool SignUpBy(int passwords, bool new_password, bool reads_as_sign_up) {
  if (passwords >= 2) {
    return true;
  }
  return passwords == 1 && (new_password || reads_as_sign_up);
}

const FormStructure* CachedForm(content::RenderFrameHost* frame,
                                const FormGlobalId& id) {
  auto* driver = autofill::ContentAutofillDriver::GetForRenderFrameHost(frame);
  return driver ? driver->GetAutofillManager().FindCachedFormById(id) : nullptr;
}

}

class LoginFormIndex::Observers
    : public content::WebContentsObserver,
      public password_manager::PasswordManagerInterface::Observer,
      public password_manager::PasswordFormManagerObserver,
      public AutofillManager::Observer {
 public:
  explicit Observers(content::WebContents* contents)
      : content::WebContentsObserver(contents) {
    if (auto* client =
            autofill::ContentAutofillClient::FromWebContents(contents)) {
      autofill_.Observe(client, autofill::ScopedAutofillManagersObservation::
                                    InitializationPolicy::
                                        kObservePreexistingManagers);
    }
    password_manager_ = PasswordManagerFor(contents);
    if (password_manager_) {
      password_manager_->AddObserver(this);
      if (auto* cache = password_manager_->GetPasswordFormCache()) {
        cache->AddObserver(this);
      }
    }
  }

  ~Observers() override { Stop(); }

  void Stop() {
    if (password_manager_) {
      if (auto* cache = password_manager_->GetPasswordFormCache()) {
        cache->RemoveObserver(this);
      }
      password_manager_->RemoveObserver(this);
      password_manager_ = nullptr;
    }
    autofill_.Reset();
    seen_.clear();
    parsed_.clear();
  }

  std::vector<LoginForm> Forms(
      std::optional<url::Origin> wanted,
      std::optional<content::GlobalRenderFrameHostId> only) const {
    std::vector<LoginForm> forms;
    if (!password_manager_ || !web_contents()) {
      return forms;
    }
    base::flat_set<std::pair<content::GlobalRenderFrameHostId, uint64_t>> covered;
    if (auto* cache = password_manager_->GetPasswordFormCache()) {
      for (const std::unique_ptr<PasswordFormManager>& manager :
           cache->GetFormManagers()) {
        content::RenderFrameHost* frame = FrameOf(manager->GetDriver().get());
        if (only && (!frame || frame->GetGlobalId() != *only)) {
          continue;
        }
        std::optional<LoginForm> form = Describe(frame, wanted);
        if (!form || !manager->observed_form()) {
          continue;
        }
        const PasswordForm* parsed = manager->GetParsedObservedForm();
        if (!parsed) {
          parsed = Parsed(*manager->observed_form());
        }
        if (!parsed) {
          continue;
        }
        form->form = parsed->form_data.renderer_id();
        form->username = parsed->username_element_renderer_id;
        form->password = parsed->password_element_renderer_id;
        form->password_name = parsed->password_element;
        int passwords = 0;
        bool new_password = parsed->HasNewPasswordElement();
        autofill::FieldRendererId text_before_password;
        for (const autofill::FormFieldData& field :
             parsed->form_data.fields()) {
          if (field.form_control_type() ==
              autofill::FormControlType::kInputPassword) {
            ++passwords;
            new_password |= MarkedNewPassword(field);
          } else if (field.is_focusable() && IsTextLike(field) &&
                     passwords == 0) {
            text_before_password = field.renderer_id();
          }
        }
        form->sign_up = SignUpBy(
            passwords, new_password,
            ReadsAsSignUp(parsed->form_data.button_titles(),
                          parsed->form_data.id_attribute(),
                          parsed->form_data.name_attribute()));
        if (!form->sign_up && passwords == 1 && form->username.is_null()) {
          form->username = text_before_password;
        }
        if (const FormStructure* cached =
                CachedForm(frame, parsed->form_data.global_id())) {
          for (const std::unique_ptr<AutofillField>& field : cached->fields()) {
            if (IsOneTimeCode(*field)) {
              form->code = field->renderer_id();
              form->code_name = field->name();
              break;
            }
          }
        }
        covered.insert({form->frame, form->form.value()});
        forms.push_back(*form);
      }
    }
    for (const auto& [id, root_id] : seen_) {
      content::RenderFrameHost* root = content::RenderFrameHost::FromID(root_id);
      const FormStructure* cached = root ? CachedForm(root, id) : nullptr;
      if (!cached) {
        continue;
      }
      std::map<autofill::FormGlobalId, std::optional<LoginForm>> pieces;
      std::map<autofill::FormGlobalId, PieceFacts> facts;
      for (const std::unique_ptr<AutofillField>& field : cached->fields()) {
        const FormGlobalId piece_id = field->renderer_form_id();
        if (IsPasswordField(*field)) {
          PieceFacts& hidden_facts = facts[piece_id];
          ++hidden_facts.passwords;
          hidden_facts.new_password |= MarkedNewPassword(*field);
        }
        if (!field->is_focusable()) {
          continue;
        }
        auto [piece, added] = pieces.try_emplace(piece_id);
        if (added) {
          content::RenderFrameHost* host =
              FrameWithToken(root, field->host_frame());
          if (host && (!only || host->GetGlobalId() == *only) &&
              !covered.contains(
                  {host->GetGlobalId(), piece_id.renderer_id.value()})) {
            piece->second = Describe(host, wanted);
          }
          if (piece->second) {
            piece->second->form = piece_id.renderer_id;
          }
        }
        std::optional<LoginForm>& form = piece->second;
        if (!form) {
          continue;
        }
        PieceFacts& piece_facts = facts[piece_id];
        if (!IsPasswordField(*field) && IsTextLike(*field) &&
            piece_facts.passwords == 0 && !IsOneTimeCode(*field)) {
          piece_facts.text_before_password = field->renderer_id();
        }
        if (IsOneTimeCode(*field) && form->code.is_null()) {
          form->code = field->renderer_id();
          form->code_name = field->name();
        } else if (IsPasswordField(*field) && form->password.is_null()) {
          form->password = field->renderer_id();
          form->password_name = field->name();
        } else if (IsUsernameLike(*field) && form->username.is_null()) {
          form->username = field->renderer_id();
        }
      }
      for (auto& [piece_id, form] : pieces) {
        if (!form) {
          continue;
        }
        const PieceFacts& piece_facts = facts[piece_id];
        const bool root_form = piece_id == id;
        form->sign_up = SignUpBy(
            piece_facts.passwords, piece_facts.new_password,
            root_form && ReadsAsSignUp(cached->button_titles(),
                                       cached->id_attribute(),
                                       cached->name_attribute()));
        if (!form->sign_up && piece_facts.passwords == 1 &&
            form->username.is_null()) {
          form->username = piece_facts.text_before_password;
        }
        if (!form->username.is_null() || !form->password.is_null() ||
            !form->code.is_null()) {
          forms.push_back(*form);
        }
      }
    }
    return forms;
  }

  base::RepeatingCallback<void(content::RenderFrameHost*)> changed;
  base::RepeatingClosure login_succeeded;

 private:
  std::optional<LoginForm> Describe(content::RenderFrameHost* frame,
                                    const std::optional<url::Origin>& wanted) const {
    if (!frame || !frame->IsActive() || frame->IsNestedWithinFencedFrame() ||
        content::WebContents::FromRenderFrameHost(frame) != web_contents()) {
      return std::nullopt;
    }
    const url::Origin& origin = frame->GetLastCommittedOrigin();
    const GURL& url = frame->GetLastCommittedURL();
    if (origin.opaque() || !url.SchemeIsHTTPOrHTTPS() ||
        !url::Origin::Create(url).IsSameOriginWith(origin)) {
      return std::nullopt;
    }
    if (wanted && !origin.IsSameOriginWith(*wanted)) {
      return std::nullopt;
    }
    LoginForm form;
    form.frame = frame->GetGlobalId();
    form.origin = origin;
    form.main_frame = frame->IsInPrimaryMainFrame();
    form.same_origin_ancestors = AncestorsShareOrigin(frame);
    return form;
  }

  const PasswordForm* Parsed(const autofill::FormData& data) const {
    const auto key =
        std::make_pair(data.global_id(), autofill::CalculateFormSignature(data));
    auto found = parsed_.find(key);
    if (found == parsed_.end()) {
      password_manager::FormDataParser parser;
      found = parsed_
                  .emplace(key, parser.Parse(data,
                                             password_manager::FormDataParser::
                                                 Mode::kFilling,
                                             {}, std::nullopt))
                  .first;
    }
    return found->second.get();
  }

  void Changed(content::RenderFrameHost* frame) {
    if (frame && changed) {
      changed.Run(frame);
    }
  }

  void OnLoginSuccessful(const PasswordForm& pending_form) override {
    if (login_succeeded) {
      login_succeeded.Run();
    }
  }

  void OnPasswordFormsParsed(
      password_manager::PasswordManagerDriver* driver,
      const std::vector<autofill::FormData>& forms_data) override {
    Changed(FrameOf(driver));
  }

  void OnPasswordFormParsed(PasswordFormManager* form_manager) override {
    Changed(FrameOf(form_manager->GetDriver().get()));
  }

  void OnAfterFormsSeen(AutofillManager& manager,
                        base::span<const FormGlobalId> updated_forms,
                        base::span<const FormGlobalId> removed_forms) override {
    content::RenderFrameHost* frame =
        static_cast<autofill::ContentAutofillDriver&>(manager.driver())
            .render_frame_host();
    for (const FormGlobalId& id : removed_forms) {
      seen_.erase(id);
    }
    base::flat_set<content::RenderFrameHost*> hosts = {frame};
    for (const FormGlobalId& id : updated_forms) {
      seen_[id] = frame->GetGlobalId();
      if (const FormStructure* cached = manager.FindCachedFormById(id)) {
        for (const std::unique_ptr<AutofillField>& field : cached->fields()) {
          if (content::RenderFrameHost* host =
                  FrameWithToken(frame, field->host_frame())) {
            hosts.insert(host);
          }
        }
      }
    }
    base::WeakPtr<Observers> alive = weak_factory_.GetWeakPtr();
    for (content::RenderFrameHost* host : hosts) {
      if (!alive) {
        return;
      }
      Changed(host);
    }
  }

  void PrimaryPageChanged(content::Page& page) override {
    parsed_.clear();
    std::erase_if(seen_, [](const auto& entry) {
      return !content::RenderFrameHost::FromID(entry.second);
    });
  }

  void WebContentsDestroyed() override { Stop(); }

  raw_ptr<password_manager::PasswordManagerInterface> password_manager_ =
      nullptr;
  std::map<FormGlobalId, content::GlobalRenderFrameHostId> seen_;
  mutable std::map<std::pair<FormGlobalId, autofill::FormSignature>,
                   std::unique_ptr<PasswordForm>>
      parsed_;
  autofill::ScopedAutofillManagersObservation autofill_{this};
  base::WeakPtrFactory<Observers> weak_factory_{this};
};

password_manager::PasswordManagerInterface* PasswordManagerFor(
    content::WebContents* contents) {
  auto* client =
      contents ? ChromePasswordManagerClient::FromWebContents(contents) : nullptr;
  return client ? client->GetPasswordManager() : nullptr;
}

LoginFormIndex::LoginFormIndex(content::WebContents* contents)
    : observers_(std::make_unique<Observers>(contents)) {}

LoginFormIndex::~LoginFormIndex() = default;

void LoginFormIndex::SetChanged(
    base::RepeatingCallback<void(content::RenderFrameHost*)> changed) {
  observers_->changed = std::move(changed);
}

void LoginFormIndex::SetLoginSucceeded(base::RepeatingClosure succeeded) {
  observers_->login_succeeded = std::move(succeeded);
}

std::vector<LoginForm> LoginFormIndex::Forms(
    std::optional<url::Origin> origin,
    std::optional<content::GlobalRenderFrameHostId> only) const {
  return observers_->Forms(std::move(origin), std::move(only));
}

void LoginFormIndex::Forget() {
  observers_->Stop();
}

namespace {

class LoginFormWatcher : public content::WebContentsUserData<LoginFormWatcher> {
 public:
  LoginFormWatcher(const LoginFormWatcher&) = delete;
  LoginFormWatcher& operator=(const LoginFormWatcher&) = delete;
  ~LoginFormWatcher() override = default;

 private:
  friend class content::WebContentsUserData<LoginFormWatcher>;

  explicit LoginFormWatcher(content::WebContents* contents)
      : content::WebContentsUserData<LoginFormWatcher>(*contents),
        index_(contents) {
    index_.SetChanged(base::BindRepeating(&LoginFormWatcher::Changed,
                                          base::Unretained(this)));
  }

  void Changed(content::RenderFrameHost* frame) {
    bool username = false;
    bool password = false;
    bool code = false;
    for (const LoginForm& form : index_.Forms(frame->GetLastCommittedOrigin(),
                                              frame->GetGlobalId())) {
      if (form.frame != frame->GetGlobalId() || form.sign_up) {
        continue;
      }
      username |= !form.username.is_null();
      password |= !form.password.is_null();
      code |= !form.code.is_null();
    }
    if (!username && !password && !code) {
      return;
    }
    const int bits = (username ? 1 : 0) | (password ? 2 : 0) | (code ? 4 : 0);
    const int64_t document = frame->GetNavigationId();
    const content::GlobalRenderFrameHostId frame_id = frame->GetGlobalId();
    auto last = reported_.find(frame_id);
    if (last != reported_.end() && last->second.first == bits &&
        last->second.second == document) {
      return;
    }
    std::erase_if(reported_, [](const auto& entry) {
      return !content::RenderFrameHost::FromID(entry.first);
    });
    reported_[frame_id] = {bits, document};
    NSDictionary* seen = @{
      @"origin" : base::SysUTF8ToNSString(
          frame->GetLastCommittedOrigin().Serialize()),
      @"hasUsername" : @(username),
      @"hasPassword" : @(password),
      @"hasOneTimeCode" : @(code),
      @"mainFrame" : @(frame->IsInPrimaryMainFrame()),
      @"document" : @(document),
    };
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<content::WebContents> contents, NSDictionary* seen) {
              if (!contents) {
                return;
              }
              ArdiaCoreTab* tab = TabBridge::GetOrCreate(contents.get())->tab();
              id<ArdiaCoreTabDelegate> delegate = tab.delegate;
              if ([delegate respondsToSelector:@selector(tab:loginFormSeen:)]) {
                [delegate tab:tab loginFormSeen:seen];
              }
            },
            GetWebContents().GetWeakPtr(), seen));
  }

  LoginFormIndex index_;
  std::map<content::GlobalRenderFrameHostId, std::pair<int, int64_t>> reported_;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(LoginFormWatcher);

}

void WatchLoginForms(content::WebContents* contents) {
  if (contents && PasswordManagerFor(contents) &&
      !LoginFormWatcher::FromWebContents(contents)) {
    LoginFormWatcher::CreateForWebContents(contents);
  }
}

}
