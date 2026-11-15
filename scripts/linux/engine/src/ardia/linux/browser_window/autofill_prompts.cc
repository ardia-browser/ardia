// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/autofill_prompts.h"

#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/modules/app_modules.h"
#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_split.h"
#include "base/strings/utf_string_conversions.h"
#include "base/supports_user_data.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/ui/autofill/address_bubbles_controller.h"
#include "chrome/browser/ui/autofill/autofill_bubble_base.h"
#include "chrome/browser/ui/autofill/payments/iban_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/offer_notification_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller.h"
#include "chrome/browser/ui/autofill/payments/save_card_bubble_controller_impl.h"
#include "chrome/browser/ui/autofill/payments/save_card_ui.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile_comparator.h"
#include "components/autofill/core/browser/data_model/payments/credit_card.h"
#include "components/autofill/core/browser/foundations/autofill_client.h"
#include "components/autofill/core/browser/ui/addresses/autofill_address_util.h"
#include "components/autofill/core/browser/ui/payments/payments_ui_closed_reasons.h"
#include "components/strings/grit/components_strings.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/l10n/l10n_util.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

using Decision = autofill::AutofillClient::AddressPromptUserDecision;

base::ListValue Lines(const std::u16string& text) {
  base::ListValue lines;
  for (const std::u16string& line : base::SplitString(
           text, u"\n", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    lines.Append(base::UTF16ToUTF8(line));
  }
  return lines;
}

int g_last_prompt_id = 0;

class Prompt;

struct PromptSlot : public base::SupportsUserData::Data {
  base::WeakPtr<Prompt> prompt;
};

const char kSlotKey[] = "ardia_linux_autofill_prompt";

class Prompt : public autofill::AutofillBubbleBase {
 public:
  explicit Prompt(content::WebContents* contents)
      : contents_(contents->GetWeakPtr()), id_(++g_last_prompt_id) {}
  Prompt(const Prompt&) = delete;
  Prompt& operator=(const Prompt&) = delete;
  ~Prompt() override = default;

  int prompt_id() const { return id_; }
  bool closed() const { return closed_; }
  base::WeakPtr<Prompt> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

  virtual base::DictValue Describe() const = 0;

  base::DictValue Payload() const {
    base::DictValue payload = Describe();
    payload.Set("id", id_);
    payload.Set("origin",
                contents_ ? contents_->GetPrimaryMainFrame()
                                ->GetLastCommittedOrigin()
                                .Serialize()
                          : std::string());
    return payload;
  }

  autofill::AutofillBubbleBase* Show() {
    auto slot = std::make_unique<PromptSlot>();
    slot->prompt = GetWeakPtr();
    contents_->SetUserData(kSlotKey, std::move(slot));
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<Prompt> prompt) {
                         if (prompt && !prompt->closed()) {
                           CountLinux("autofillPrompts");
                           prompt->Notify(prompt->Payload());
                         }
                       },
                       GetWeakPtr()));
    return this;
  }

  bool Answer(const std::string& answer) {
    if (closed_) {
      return false;
    }
    if (answer == "accept") {
      CountLinux("autofillPromptAccepts");
      Accept();
    } else if (answer == "decline") {
      Decline();
    } else if (answer != "dismiss") {
      return false;
    }
    Close(ClosedBy::kUser, answer);
    return true;
  }

  void Hide() override { Close(ClosedBy::kChrome, std::string()); }
  bool IsMouseHovered() const override { return false; }

 protected:
  enum class ClosedBy { kUser, kChrome };

  virtual void Accept() = 0;
  virtual void Decline() = 0;
  virtual void Closed(ClosedBy by, const std::string& answer) = 0;

 private:
  void Close(ClosedBy by, const std::string& answer) {
    if (closed_) {
      return;
    }
    closed_ = true;
    if (contents_) {
      auto* slot = static_cast<PromptSlot*>(contents_->GetUserData(kSlotKey));
      if (slot && slot->prompt.get() == this) {
        contents_->RemoveUserData(kSlotKey);
      }
    }
    base::DictValue closed;
    closed.Set("id", id_);
    closed.Set("closed", true);
    Notify(std::move(closed));
    Closed(by, answer);
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                               this);
  }

  void Notify(base::DictValue payload) const {
    ardia_win::TabState* tab =
        contents_ ? ardia_win::TabState::FromWebContents(contents_.get())
                  : nullptr;
    if (tab && !tab->key().empty()) {
      tab->Send("autofillPrompt", std::move(payload));
    }
  }

  base::WeakPtr<content::WebContents> contents_;
  const int id_;
  bool closed_ = false;
  base::WeakPtrFactory<Prompt> weak_factory_{this};
};

class SaveAddressPrompt : public Prompt {
 public:
  SaveAddressPrompt(
      content::WebContents* contents,
      std::unique_ptr<autofill::SaveAddressBubbleController> controller)
      : Prompt(contents), controller_(std::move(controller)) {}

  base::DictValue Describe() const override {
    base::ListValue lines = Lines(controller_->GetAddressSummary());
    for (const std::u16string& extra :
         {controller_->GetProfileEmail(), controller_->GetProfilePhone()}) {
      if (!extra.empty()) {
        lines.Append(base::UTF16ToUTF8(extra));
      }
    }
    base::DictValue described;
    described.Set("kind", "saveAddress");
    described.Set("title", controller_->GetWindowTitle());
    described.Set("message", controller_->GetBodyText());
    described.Set("accept", controller_->GetOkButtonLabel());
    described.Set("decline", controller_->GetNegativeButtonLabel());
    described.Set("footer", controller_->GetFooterMessage());
    described.Set("lines", std::move(lines));
    return described;
  }

 protected:
  void Accept() override {
    controller_->OnUserDecision(Decision::kAccepted,
                                controller_->GetAutofillProfile());
  }
  void Decline() override {
    controller_->OnUserDecision(controller_->GetCancelCallbackValue(),
                                std::nullopt);
  }
  void Closed(ClosedBy, const std::string&) override {
    controller_->OnBubbleClosed();
  }

 private:
  std::unique_ptr<autofill::SaveAddressBubbleController> controller_;
};

class UpdateAddressPrompt : public Prompt {
 public:
  UpdateAddressPrompt(
      content::WebContents* contents,
      std::unique_ptr<autofill::UpdateAddressBubbleController> controller)
      : Prompt(contents), controller_(std::move(controller)) {}

  base::DictValue Describe() const override {
    const std::string& locale = g_browser_process->GetApplicationLocale();
    const std::vector<autofill::ProfileValueDifference> diff =
        autofill::GetProfileDifferenceForUi(controller_->GetProfileToSave(),
                                            controller_->GetOriginalProfile(),
                                            locale);
    bool adds_only = true;
    bool has_address = false;
    base::ListValue changes;
    for (const autofill::ProfileValueDifference& entry : diff) {
      adds_only = adds_only && entry.second_value.empty();
      has_address =
          has_address || entry.type == autofill::ADDRESS_HOME_ADDRESS;
      std::string field = "other";
      switch (autofill::GetAddressUIComponentIconTypeForFieldType(entry.type)) {
        case autofill::AddressUIComponentIconType::kName:
          field = "name";
          break;
        case autofill::AddressUIComponentIconType::kAddress:
          field = "address";
          break;
        case autofill::AddressUIComponentIconType::kEmail:
          field = "email";
          break;
        case autofill::AddressUIComponentIconType::kPhone:
          field = "phone";
          break;
        case autofill::AddressUIComponentIconType::kNoIcon:
          break;
      }
      base::DictValue change;
      change.Set("field", field);
      change.Set("to", entry.first_value);
      change.Set("from", entry.second_value);
      changes.Append(std::move(change));
    }
    base::DictValue described;
    described.Set("kind", "updateAddress");
    described.Set("title", controller_->GetWindowTitle(adds_only));
    described.Set("message", autofill::GetProfileDescription(
                                 controller_->GetOriginalProfile(), locale,
                                 !has_address));
    described.Set("accept", controller_->GetPositiveButtonText(adds_only));
    described.Set("decline", controller_->GetNegativeButtonText(adds_only));
    described.Set("footer", controller_->GetFooterMessage());
    described.Set("lines", base::ListValue());
    described.Set("changes", std::move(changes));
    described.Set(
        "newLabel",
        adds_only
            ? std::u16string()
            : l10n_util::GetStringUTF16(
                  IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_NEW_VALUES_SECTION_LABEL));
    described.Set(
        "oldLabel",
        adds_only
            ? std::u16string()
            : l10n_util::GetStringUTF16(
                  IDS_AUTOFILL_UPDATE_ADDRESS_PROMPT_OLD_VALUES_SECTION_LABEL));
    return described;
  }

 protected:
  void Accept() override {
    controller_->OnUserDecision(Decision::kAccepted,
                                controller_->GetProfileToSave());
  }
  void Decline() override {
    controller_->OnUserDecision(Decision::kDeclined, std::nullopt);
  }
  void Closed(ClosedBy, const std::string&) override {
    controller_->OnBubbleClosed();
  }

 private:
  std::unique_ptr<autofill::UpdateAddressBubbleController> controller_;
};

class SaveCardPrompt : public Prompt {
 public:
  SaveCardPrompt(content::WebContents* contents,
                 autofill::SaveCardBubbleController* controller)
      : Prompt(contents),
        controller_(controller),
        on_closed_(controller->GetOnBubbleClosedCallback()) {}

  base::DictValue Describe() const override {
    const autofill::CreditCard& card = controller_->GetCard();
    std::u16string identifier = card.CardNameAndLastFourDigits(u"", 2);
    if (!card.IsExpired(base::Time::Now())) {
      identifier += u" • " + card.AbbreviatedExpirationDateForDisplay(false);
    }
    base::ListValue lines;
    lines.Append(identifier);
    base::DictValue described;
    described.Set("kind", "saveCard");
    described.Set("title", controller_->GetWindowTitle());
    described.Set("message", controller_->GetExplanatoryMessage());
    described.Set("accept", controller_->GetAcceptButtonText());
    described.Set("decline", controller_->GetDeclineButtonText());
    described.Set("footer", "");
    described.Set("lines", std::move(lines));
    return described;
  }

 protected:
  void Accept() override { controller_->OnSaveButton({}); }
  void Decline() override {}
  void Closed(ClosedBy by, const std::string& answer) override {
    autofill::PaymentsUiClosedReason reason =
        autofill::PaymentsUiClosedReason::kNotInteracted;
    if (by == ClosedBy::kUser) {
      reason = answer == "accept"    ? autofill::PaymentsUiClosedReason::kAccepted
               : answer == "decline" ? autofill::PaymentsUiClosedReason::kCancelled
                                     : autofill::PaymentsUiClosedReason::kClosed;
    }
    if (on_closed_) {
      std::move(on_closed_).Run(reason);
    }
  }

 private:
  raw_ptr<autofill::SaveCardBubbleController> controller_;
  base::OnceCallback<void(autofill::PaymentsUiClosedReason)> on_closed_;
};

class SkippedBubble : public autofill::AutofillBubbleBase {
 public:
  using CloseCallback = base::OnceCallback<void(content::WebContents*,
                                                autofill::AutofillBubbleBase*)>;

  SkippedBubble(content::WebContents* contents, CloseCallback close)
      : contents_(contents->GetWeakPtr()), close_(std::move(close)) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&SkippedBubble::CloseNow, weak_factory_.GetWeakPtr()));
  }

  void Hide() override {
    if (!hidden_) {
      hidden_ = true;
      base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                                 this);
    }
  }
  bool IsMouseHovered() const override { return false; }

 private:
  void CloseNow() {
    if (hidden_) {
      return;
    }
    hidden_ = true;
    if (contents_) {
      std::move(close_).Run(contents_.get(), this);
    }
    delete this;
  }

  base::WeakPtr<content::WebContents> contents_;
  CloseCallback close_;
  bool hidden_ = false;
  base::WeakPtrFactory<SkippedBubble> weak_factory_{this};
};

Prompt* PendingPrompt(content::WebContents* contents) {
  auto* slot = contents
                   ? static_cast<PromptSlot*>(contents->GetUserData(kSlotKey))
                   : nullptr;
  Prompt* prompt = slot ? slot->prompt.get() : nullptr;
  return prompt && !prompt->closed() ? prompt : nullptr;
}

}

autofill::AutofillBubbleBase* ShowSaveAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::SaveAddressBubbleController> controller) {
  return (new SaveAddressPrompt(contents, std::move(controller)))->Show();
}

autofill::AutofillBubbleBase* ShowUpdateAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::UpdateAddressBubbleController> controller) {
  return (new UpdateAddressPrompt(contents, std::move(controller)))->Show();
}

autofill::AutofillBubbleBase* ShowSaveCardPrompt(
    content::WebContents* contents,
    autofill::SaveCardBubbleController* controller) {
  switch (controller->GetPaymentsBubbleType()) {
    case autofill::PaymentsBubbleType::kLocalSave:
    case autofill::PaymentsBubbleType::kLocalCvcSave:
      return (new SaveCardPrompt(contents, controller))->Show();
    default:
      return new SkippedBubble(
          contents,
          base::BindOnce([](content::WebContents* contents,
                            autofill::AutofillBubbleBase* bubble) {
            auto* skipped =
                autofill::SaveCardBubbleControllerImpl::FromWebContents(
                    contents);
            if (skipped && skipped->GetPaymentBubbleView() == bubble) {
              skipped->OnBubbleClosed(
                  autofill::PaymentsUiClosedReason::kNotInteracted);
            }
          }));
  }
}

autofill::AutofillBubbleBase* SkipIbanBubble(content::WebContents* contents) {
  return new SkippedBubble(
      contents, base::BindOnce([](content::WebContents* contents,
                                  autofill::AutofillBubbleBase* bubble) {
        auto* controller =
            autofill::IbanBubbleControllerImpl::FromWebContents(contents);
        if (controller && controller->GetPaymentBubbleView() == bubble) {
          controller->OnBubbleClosed(
              autofill::PaymentsUiClosedReason::kNotInteracted);
        }
      }));
}

autofill::AutofillBubbleBase* SkipOfferNotification(
    content::WebContents* contents) {
  return new SkippedBubble(
      contents, base::BindOnce([](content::WebContents* contents,
                                  autofill::AutofillBubbleBase* bubble) {
        auto* controller =
            autofill::OfferNotificationBubbleControllerImpl::FromWebContents(
                contents);
        if (controller &&
            controller->GetOfferNotificationBubbleView() == bubble) {
          controller->OnBubbleClosed(
              autofill::PaymentsUiClosedReason::kNotInteracted);
        }
      }));
}

autofill::AutofillBubbleBase* SkipAddressSignInPromo(
    content::WebContents* contents) {
  return new SkippedBubble(
      contents, base::BindOnce([](content::WebContents* contents,
                                  autofill::AutofillBubbleBase* bubble) {
        auto* controller =
            autofill::AddressBubblesController::FromWebContents(contents);
        if (controller && controller->GetBubbleView() == bubble) {
          controller->OnBubbleClosed();
        }
      }));
}

std::optional<base::DictValue> PendingAutofillPrompt(
    content::WebContents* contents) {
  Prompt* prompt = PendingPrompt(contents);
  if (!prompt) {
    return std::nullopt;
  }
  return prompt->Payload();
}

bool ResolveAutofillPrompt(content::WebContents* contents,
                           int prompt_id,
                           const std::string& answer) {
  Prompt* prompt = PendingPrompt(contents);
  return prompt && prompt->prompt_id() == prompt_id && prompt->Answer(answer);
}

}
