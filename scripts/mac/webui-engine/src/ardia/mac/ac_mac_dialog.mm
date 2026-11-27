#include "ardia/mac/ac_mac_dialog.h"

#import <AppKit/AppKit.h>

#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "ui/views/widget/widget.h"

namespace ardia_mac {

namespace {

constexpr CGFloat kPromptFieldWidth = 260;
constexpr CGFloat kPromptFieldHeight = 24;

dialog_policy::Text TextField(const base::DictValue* dict, std::string_view key) {
  dialog_policy::Text text;
  const base::Value* value = dict ? dict->Find(key) : nullptr;
  text.present = value != nullptr;
  text.is_string = value && value->is_string();
  if (text.is_string) {
    text.value = value->GetString();
  }
  return text;
}

dialog_policy::Request RequestFrom(const base::DictValue& request) {
  dialog_policy::Request parsed;
  parsed.dialog_id = TextField(&request, "dialogId");
  parsed.kind = TextField(&request, "kind");
  const base::DictValue* options = request.FindDict("options");
  parsed.has_options = options != nullptr;
  parsed.window_id = TextField(options, "windowId");
  parsed.title = TextField(options, "title");
  parsed.message = TextField(options, "message");
  parsed.confirm_title = TextField(options, "confirmTitle");
  parsed.cancel_title = TextField(options, "cancelTitle");
  parsed.suppression = TextField(options, "suppression");
  parsed.value = TextField(options, "value");
  parsed.placeholder = TextField(options, "placeholder");
  const base::Value* destructive = options ? options->Find("destructive") : nullptr;
  parsed.destructive.present = destructive != nullptr;
  parsed.destructive.is_bool = destructive && destructive->is_bool();
  parsed.destructive.value = destructive && destructive->is_bool() && destructive->GetBool();
  return parsed;
}

NSString* Shown(const std::string& text) {
  return base::SysUTF8ToNSString(text) ?: @"";
}

base::Value Envelope(const std::string& window_id,
                     const std::string& generation,
                     const dialog_policy::Spec& spec,
                     const dialog_policy::Resolution& resolution) {
  base::Value result;
  if (resolution.prompt) {
    result = resolution.text ? base::Value(*resolution.text) : base::Value();
  } else {
    result = base::Value(base::DictValue()
                             .Set("confirmed", resolution.confirmed)
                             .Set("suppressed", resolution.suppressed));
  }
  return base::Value(base::DictValue()
                         .Set("name", dialog_policy::kResolvedEvent)
                         .Set("data", base::DictValue()
                                          .Set("dialogId", spec.dialog_id)
                                          .Set("windowId", window_id)
                                          .Set("rendererGeneration", generation)
                                          .Set("result", std::move(result))));
}

}

struct DialogSheets::Sheet {
  NSAlert* alert = nil;
  NSWindow* __weak window = nil;
  std::uint64_t sequence = 0;
  bool ended = false;
};

DialogSheets::DialogSheets(views::Widget* parent, std::string window_id, bool background, Resolved resolved)
    : parent_(parent ? parent->GetWeakPtr() : base::WeakPtr<views::Widget>()),
      window_id_(std::move(window_id)),
      background_(background),
      resolved_(std::move(resolved)) {}

DialogSheets::~DialogSheets() {
  weak_factory_.InvalidateWeakPtrs();
  Dismiss();
  sheet_.reset();
}

dialog_policy::Refusal DialogSheets::Begin(const base::DictValue& request,
                                           const std::string& generation,
                                           const std::string& live_generation) {
  if (!dialog_policy::ValidGeneration(generation) || generation != live_generation) {
    return dialog_policy::Refusal::kNotCurrent;
  }
  if (queue_.suspended()) {
    return dialog_policy::Refusal::kSuspended;
  }
  const std::optional<dialog_policy::Spec> spec = dialog_policy::Parse(RequestFrom(request), window_id_);
  if (!spec) {
    return dialog_policy::Refusal::kInvalid;
  }
  const dialog_policy::Refusal refusal = queue_.Admit(*spec, generation, live_generation);
  if (refusal == dialog_policy::Refusal::kNone) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&DialogSheets::Pump, weak_factory_.GetWeakPtr()));
  }
  return refusal;
}

bool DialogSheets::Cancel(const std::string& dialog_id) {
  if (!dialog_policy::ValidDialogId(dialog_id)) {
    return false;
  }
  if (const dialog_policy::Queue::Entry* entry = queue_.Find(dialog_id)) {
    Complete(dialog_id, entry->sequence, dialog_policy::Response{.forced = true});
  }
  return true;
}

void DialogSheets::CancelAll() {
  if (cancelling_) {
    return;
  }
  cancelling_ = true;
  std::vector<std::pair<std::string, std::uint64_t>> entries;
  for (const auto& [id, entry] : queue_.entries()) {
    entries.emplace_back(id, entry.sequence);
  }
  base::WeakPtr<DialogSheets> alive = weak_factory_.GetWeakPtr();
  for (const auto& [id, sequence] : entries) {
    Complete(id, sequence, dialog_policy::Response{.forced = true});
    if (!alive) {
      return;
    }
  }
  cancelling_ = false;
}

std::uint64_t DialogSheets::Suspend() {
  const std::uint64_t token = queue_.Suspend();
  CancelAll();
  return token;
}

bool DialogSheets::Resume(std::uint64_t token) {
  const bool resumed = queue_.Resume(token);
  if (resumed) {
    Pump();
  }
  return resumed;
}

void DialogSheets::Pump() {
  if (pumping_ || cancelling_) {
    return;
  }
  pumping_ = true;
  base::WeakPtr<DialogSheets> alive = weak_factory_.GetWeakPtr();
  while (const dialog_policy::Queue::Entry* next = queue_.Next()) {
    const dialog_policy::Queue::Entry entry = *next;
    if (!queue_.Show(entry.sequence)) {
      break;
    }
    Present(entry);
    if (!alive) {
      return;
    }
    if (queue_.IsActive(entry.sequence)) {
      break;
    }
  }
  pumping_ = false;
}

void DialogSheets::Present(const dialog_policy::Queue::Entry& entry) {
  const dialog_policy::Spec& spec = entry.spec;
  const std::string dialog_id = spec.dialog_id;
  const std::uint64_t sequence = entry.sequence;
  NSWindow* window = parent_ && !parent_->IsClosed() ? parent_->GetNativeWindow().GetNativeNSWindow() : nil;
  if (background_ || !window) {
    LOG(WARNING) << "Ardia Mac WebUI: " << (spec.prompt ? "prompt" : "confirm")
                 << " dialog (background run, not shown): \"" << dialog_policy::Displayable(spec.title)
                 << "\" (" << dialog_policy::ButtonTitle(spec.confirm_title, "OK") << " / "
                 << dialog_policy::ButtonTitle(spec.cancel_title, "Cancel") << "): cancelled";
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&DialogSheets::Complete, weak_factory_.GetWeakPtr(), dialog_id, sequence,
                                  dialog_policy::Response{.forced = true}));
    return;
  }
  NSAlert* alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleInformational;
  alert.messageText = Shown(dialog_policy::Displayable(spec.title));
  alert.informativeText = Shown(dialog_policy::Displayable(spec.message));
  NSButton* confirm = [alert addButtonWithTitle:Shown(dialog_policy::ButtonTitle(spec.confirm_title, "OK"))];
  confirm.hasDestructiveAction = spec.destructive;
  NSButton* cancel = [alert addButtonWithTitle:Shown(dialog_policy::ButtonTitle(spec.cancel_title, "Cancel"))];
  cancel.keyEquivalent = @"\033";
  NSTextField* field = nil;
  if (spec.prompt) {
    field = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, kPromptFieldWidth, kPromptFieldHeight)];
    field.stringValue = Shown(spec.value);
    field.placeholderString = Shown(dialog_policy::Displayable(spec.placeholder));
    alert.accessoryView = field;
  }
  if (spec.has_suppression) {
    alert.showsSuppressionButton = YES;
    if (!spec.suppression.empty()) {
      alert.suppressionButton.title = Shown(dialog_policy::ButtonTitle(spec.suppression, "Don't ask again"));
    }
  }
  [alert layout];
  if (field) {
    alert.window.initialFirstResponder = field;
  }
  sheet_ = std::make_unique<Sheet>();
  sheet_->alert = alert;
  sheet_->window = window;
  sheet_->sequence = sequence;
  base::WeakPtr<DialogSheets> weak = weak_factory_.GetWeakPtr();
  NSAlert* __weak answered = alert;
  NSTextField* __weak typed = field;
  [alert beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse code) {
                  dialog_policy::Response response;
                  response.accepted = code == NSAlertFirstButtonReturn;
                  response.forced = code != NSAlertFirstButtonReturn && code != NSAlertSecondButtonReturn;
                  response.suppressed = answered.suppressionButton.state == NSControlStateValueOn;
                  if (typed) {
                    response.text = base::SysNSStringToUTF8(typed.stringValue);
                  }
                  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
                      FROM_HERE, base::BindOnce(&DialogSheets::Complete, weak, dialog_id, sequence,
                                                std::move(response)));
                }];
}

void DialogSheets::Dismiss() {
  if (!sheet_ || sheet_->ended) {
    return;
  }
  sheet_->ended = true;
  NSWindow* parent = sheet_->window;
  NSWindow* shown = sheet_->alert.window;
  if (parent && shown && shown.sheetParent == parent) {
    [parent endSheet:shown returnCode:NSModalResponseAbort];
  }
}

void DialogSheets::Complete(std::string dialog_id, std::uint64_t sequence, dialog_policy::Response response) {
  std::optional<dialog_policy::Queue::Entry> entry = queue_.Complete(dialog_id, sequence);
  if (!entry) {
    return;
  }
  if (sheet_ && sheet_->sequence == sequence) {
    Dismiss();
    sheet_.reset();
  }
  base::WeakPtr<DialogSheets> alive = weak_factory_.GetWeakPtr();
  resolved_.Run(Envelope(window_id_, entry->generation, entry->spec, dialog_policy::Resolve(entry->spec, response)));
  if (alive && !cancelling_) {
    Pump();
  }
}

}
