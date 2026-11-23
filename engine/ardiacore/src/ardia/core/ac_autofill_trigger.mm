#include "ardia/core/ac_autofill_trigger.h"

#include "ardia/core/ac_autofill_fill.h"

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "components/autofill/core/browser/suggestions/suggestion.h"
#include "components/autofill/core/browser/suggestions/suggestion_type.h"
#include "components/autofill/content/browser/content_autofill_client.h"
#include "components/autofill/content/browser/content_autofill_driver.h"
#include "components/autofill/core/browser/foundations/autofill_driver.h"
#include "components/autofill/core/browser/foundations/autofill_manager.h"
#include "components/autofill/core/browser/foundations/scoped_autofill_managers_observation.h"
#include "components/autofill/core/common/aliases.h"
#include "components/autofill/core/common/unique_ids.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ardia/core/ac_hooks.h"
#include "ardia/core/ac_browser.h"
#import "ardia/core/ardiacore_internal.h"

namespace ardiacore {

namespace {

using autofill::AutofillManager;
using autofill::AutofillSuggestionTriggerSource;
using autofill::FieldGlobalId;
using autofill::FormGlobalId;

class FocusedField : public content::WebContentsUserData<FocusedField>,
                     public AutofillManager::Observer {
 public:
  FocusedField(const FocusedField&) = delete;
  FocusedField& operator=(const FocusedField&) = delete;
  ~FocusedField() override { ClaimMenuKeys(false); }

  void ClaimMenuKeys(bool claim) {
    if (content::RenderFrameHost* held = content::RenderFrameHost::FromID(keys_frame_)) {
      held->GetRenderWidgetHost()->RemoveKeyPressEventCallback(keys_);
    }
    keys_frame_ = content::GlobalRenderFrameHostId();
    content::RenderFrameHost* frame = GetWebContents().GetFocusedFrame();
    if (!claim || !frame) {
      return;
    }
    keys_ = base::BindRepeating(&FocusedField::MenuKey, base::Unretained(this));
    frame->GetRenderWidgetHost()->AddKeyPressEventCallback(keys_);
    keys_frame_ = frame->GetGlobalId();
  }

  bool Trigger(AutofillSuggestionTriggerSource source) {
    AutofillManager* manager = manager_.get();
    content::RenderFrameHost* frame = GetWebContents().GetFocusedFrame();
    auto* driver =
        frame ? autofill::ContentAutofillDriver::GetForRenderFrameHost(frame)
              : nullptr;
    if (!manager || !driver || !driver->IsActive() ||
        &driver->GetAutofillManager() != manager) {
      return false;
    }
    static_cast<autofill::AutofillDriver*>(driver)
        ->RendererShouldTriggerSuggestions(field_, source);
    return true;
  }

  bool Fill(AutofillEntryKind kind, const std::string& guid) {
    AutofillManager* manager = manager_.get();
    return manager && FillAutofillEntry(&GetWebContents(), *manager, form_,
                                        field_, kind, guid);
  }

 private:
  friend class content::WebContentsUserData<FocusedField>;

  FocusedField(content::WebContents* web_contents,
               autofill::ContentAutofillClient* client)
      : content::WebContentsUserData<FocusedField>(*web_contents) {
    observation_.Observe(client, autofill::ScopedAutofillManagersObservation::
                                     InitializationPolicy::
                                         kObservePreexistingManagers);
  }

  void OnAfterFocusOnFormField(AutofillManager& manager,
                               FormGlobalId form,
                               FieldGlobalId field) override {
    Focused(manager, form, field);
    ReportAutofillField(&GetWebContents(), manager, form, field, false);
  }
  void OnAfterAskForValuesToFill(AutofillManager& manager,
                                 FormGlobalId form,
                                 FieldGlobalId field) override {
    Focused(manager, form, field);
    ReportAutofillField(&GetWebContents(), manager, form, field, true);
  }
  void OnAfterFocusOnNonFormField(AutofillManager& manager) override {
    if (manager_.get() == &manager) {
      manager_.reset();
      ReportAutofillFieldLeft(&GetWebContents());
    }
  }

  void Focused(AutofillManager& manager, FormGlobalId form, FieldGlobalId field) {
    manager_ = manager.GetWeakPtr();
    form_ = form;
    field_ = field;
  }

  bool MenuKey(const input::NativeWebKeyboardEvent& event) {
    if (event.GetType() != blink::WebInputEvent::Type::kRawKeyDown ||
        event.GetModifiers() & blink::WebInputEvent::kKeyModifiers) {
      return false;
    }
    NSString* key = nil;
    switch (event.windows_key_code) {
      case ui::VKEY_UP:
        key = @"ArrowUp";
        break;
      case ui::VKEY_DOWN:
        key = @"ArrowDown";
        break;
      case ui::VKEY_RETURN:
        key = @"Enter";
        break;
      case ui::VKEY_ESCAPE:
        key = @"Escape";
        break;
      case ui::VKEY_TAB:
        key = @"Tab";
        break;
      default:
        return false;
    }
    ReportAutofillMenuKey(&GetWebContents(), key);
    return event.windows_key_code != ui::VKEY_TAB;
  }

  content::RenderWidgetHost::KeyPressEventCallback keys_;
  content::GlobalRenderFrameHostId keys_frame_;
  base::WeakPtr<AutofillManager> manager_;
  FormGlobalId form_;
  FieldGlobalId field_;
  autofill::ScopedAutofillManagersObservation observation_{this};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(FocusedField);

void ReportShown(content::WebContents* contents,
                 base::span<const autofill::Suggestion> suggestions) {
  if (!contents || !FocusedField::FromWebContents(contents)) {
    return;
  }
  NSMutableArray* items = [NSMutableArray array];
  for (const autofill::Suggestion& suggestion : suggestions) {
    if (suggestion.type == autofill::SuggestionType::kSeparator) {
      continue;
    }
    NSMutableArray* labels = [NSMutableArray array];
    for (const auto& row : suggestion.labels) {
      for (const auto& text : row) {
        if (!text.value.empty()) {
          [labels addObject:base::SysUTF16ToNSString(text.value)];
        }
      }
    }
    NSMutableArray* minor = [NSMutableArray array];
    for (const auto& text : suggestion.minor_texts) {
      if (!text.value.empty()) {
        [minor addObject:base::SysUTF16ToNSString(text.value)];
      }
    }
    [items addObject:@{
      @"label" : base::SysUTF16ToNSString(suggestion.main_text.value),
      @"sublabel" : [labels componentsJoinedByString:@" "],
      @"minorText" : [minor componentsJoinedByString:@" "],
      @"type" : base::SysUTF8ToNSString(autofill::SuggestionTypeToString(suggestion.type)),
    }];
  }
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<content::WebContents> contents, NSArray* items) {
                       if (!contents) {
                         return;
                       }
                       ArdiaCoreTab* tab = TabBridge::GetOrCreate(contents.get())->tab();
                       id<ArdiaCoreTabDelegate> delegate = tab.delegate;
                       if ([delegate respondsToSelector:@selector
                                     (tab:didShowAutofillSuggestions:)]) {
                         [delegate tab:tab didShowAutofillSuggestions:items];
                       }
                     },
                     contents->GetWeakPtr(), items));
}

}

void TrackAutofillFocus(content::WebContents* contents) {
  autofill::g_ardia_autofill_suggestions_shown = &ReportShown;
  auto* client =
      contents ? autofill::ContentAutofillClient::FromWebContents(contents) : nullptr;
  if (client && !FocusedField::FromWebContents(contents)) {
    FocusedField::CreateForWebContents(contents, client);
  }
}

void ClaimAutofillMenuKeys(content::WebContents* contents, bool claim) {
  if (auto* focused = contents ? FocusedField::FromWebContents(contents) : nullptr) {
    focused->ClaimMenuKeys(claim);
  }
}

bool FillFocusedAutofillEntry(content::WebContents* contents,
                              AutofillEntryKind kind,
                              const std::string& guid) {
  auto* focused = contents ? FocusedField::FromWebContents(contents) : nullptr;
  return focused && focused->Fill(kind, guid);
}

bool ShowAutofillSuggestions(content::WebContents* contents, bool passwords) {
  if (!contents) {
    return false;
  }
  TrackAutofillFocus(contents);
  auto* focused = FocusedField::FromWebContents(contents);
  return focused &&
         focused->Trigger(passwords
                              ? AutofillSuggestionTriggerSource::kManualFallbackPasswords
                              : AutofillSuggestionTriggerSource::kFormControlElementClicked);
}

}
