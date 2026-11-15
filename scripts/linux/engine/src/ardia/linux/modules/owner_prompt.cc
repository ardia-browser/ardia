// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/owner_prompt.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/owner_check_core.h"
#include "ardia/linux/modules/owner_window.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "components/constrained_window/constrained_window_views.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/base/mojom/ui_base_types.mojom.h"
#include "ui/base/ime/text_input_type.h"
#include "ui/color/color_id.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/layout/box_layout_view.h"
#include "ui/views/style/typography.h"
#include "ui/views/widget/widget.h"
#include "ui/views/widget/widget_observer.h"
#include "ui/views/window/dialog_delegate.h"

namespace ardia_linux {

namespace {

constexpr int kPromptWidth = 440;
constexpr base::TimeDelta kCountdownTick = base::Milliseconds(250);

views::Widget* ShowDialog(std::unique_ptr<views::DialogDelegate> dialog) {
  views::Widget* owner = OwnerWidget();
  dialog->SetModalType(owner ? ui::mojom::ModalType::kWindow
                             : ui::mojom::ModalType::kNone);
  views::Widget* widget =
      owner ? constrained_window::CreateBrowserModalDialogViews(
                  std::move(dialog), owner->GetNativeWindow())
            : views::DialogDelegate::CreateDialogWidget(
                  std::move(dialog), gfx::NativeWindow(), gfx::NativeView());
  if (CurrentLaunchConfig().background) {
    widget->ShowInactive();
  } else {
    widget->Show();
  }
  return widget;
}

std::unique_ptr<views::Label> BodyLabel(const std::u16string& text,
                                        int style) {
  auto label = std::make_unique<views::Label>(
      text, views::style::CONTEXT_DIALOG_BODY_TEXT, style);
  label->SetMultiLine(true);
  label->SetHorizontalAlignment(gfx::ALIGN_LEFT);
  return label;
}

class WindowOwnerPrompt : public OwnerPrompt, public views::WidgetObserver {
 public:
  WindowOwnerPrompt(const std::string& reason, base::TimeDelta retry) {
    auto dialog = std::make_unique<views::DialogDelegate>();
    dialog->SetTitle(base::UTF8ToUTF16("Ardia wants to " + reason + "."));
    dialog->SetShowCloseButton(false);
    dialog->set_fixed_width(kPromptWidth);
    dialog->SetButtonLabel(ui::mojom::DialogButton::kOk, u"OK");
    dialog->SetButtonLabel(ui::mojom::DialogButton::kCancel, u"Cancel");
    dialog->SetAcceptCallbackWithClose(base::BindRepeating(
        [](base::WeakPtr<WindowOwnerPrompt> prompt) {
          return prompt ? prompt->Submit() : true;
        },
        weak_factory_.GetWeakPtr()));
    dialog->SetCancelCallback(base::BindOnce(&WindowOwnerPrompt::Dismissed,
                                             weak_factory_.GetWeakPtr()));
    dialog->SetCloseCallback(base::BindOnce(&WindowOwnerPrompt::Dismissed,
                                            weak_factory_.GetWeakPtr()));
    auto contents = std::make_unique<views::BoxLayoutView>();
    contents->SetOrientation(views::BoxLayout::Orientation::kVertical);
    contents->SetBetweenChildSpacing(10);
    contents->SetCrossAxisAlignment(
        views::BoxLayout::CrossAxisAlignment::kStretch);
    contents->AddChildView(BodyLabel(u"Enter your login password to allow this.",
                                     views::style::STYLE_SECONDARY));
    auto field = std::make_unique<views::Textfield>();
    field->SetTextInputType(ui::TEXT_INPUT_TYPE_PASSWORD);
    field->GetViewAccessibility().SetName(u"Login password");
    field_ = contents->AddChildView(std::move(field));
    auto error = BodyLabel(std::u16string(), views::style::STYLE_PRIMARY);
    error->SetEnabledColor(ui::kColorAlertHighSeverity);
    error_ = contents->AddChildView(std::move(error));
    dialog->SetInitiallyFocusedView(field_);
    dialog->SetContentsView(std::move(contents));
    dialog_ = dialog.get();
    widget_ = ShowDialog(std::move(dialog));
    observation_.Observe(widget_);
    if (retry.is_positive()) {
      Refuse(std::string(), retry);
    } else {
      SetWaiting(false);
    }
  }

  ~WindowOwnerPrompt() override {
    answered_.Reset();
    observation_.Reset();
    if (widget_) {
      views::Widget* widget = widget_;
      widget_ = nullptr;
      dialog_ = nullptr;
      field_ = nullptr;
      error_ = nullptr;
      widget->CloseWithReason(views::Widget::ClosedReason::kUnspecified);
    }
  }

  void NextAnswer(Answered answered) override {
    answered_ = std::move(answered);
    if (!widget_) {
      Answer(std::nullopt);
      return;
    }
    field_->SetEnabled(true);
    field_->RequestFocus();
    ShowError();
  }

  void Refuse(const std::string& message, base::TimeDelta retry) override {
    if (!widget_) {
      return;
    }
    field_->SetText(std::u16string());
    said_ = base::UTF8ToUTF16(message);
    wait_until_ = base::TimeTicks::Now() + retry;
    countdown_.Stop();
    if (retry.is_positive()) {
      countdown_.Start(FROM_HERE, kCountdownTick,
                       base::BindRepeating(&WindowOwnerPrompt::ShowError,
                                           base::Unretained(this)));
    }
    ShowError();
  }

  void Focus() override {
    if (widget_) {
      widget_->Activate();
    }
  }

  void OnWidgetDestroying(views::Widget* widget) override {
    observation_.Reset();
    widget_ = nullptr;
    dialog_ = nullptr;
    field_ = nullptr;
    error_ = nullptr;
    countdown_.Stop();
    Answer(std::nullopt);
  }

 private:
  bool Waiting() const { return wait_until_ > base::TimeTicks::Now(); }

  void SetWaiting(bool waiting) {
    if (dialog_) {
      dialog_->SetButtonEnabled(ui::mojom::DialogButton::kOk,
                                !waiting && !answered_.is_null());
    }
  }

  void ShowError() {
    if (!widget_) {
      return;
    }
    base::TimeDelta left = wait_until_ - base::TimeTicks::Now();
    if (left.is_positive()) {
      const int seconds = static_cast<int>(left.InSecondsF() + 0.999);
      std::u16string text = said_.empty() ? std::u16string() : said_ + u" ";
      text += u"Try again in " + base::NumberToString16(seconds) + u" s.";
      error_->SetText(text);
      SetWaiting(true);
      return;
    }
    countdown_.Stop();
    error_->SetText(said_.empty() ? std::u16string() : said_ + u" Try again.");
    SetWaiting(false);
  }

  bool Submit() {
    if (!field_ || answered_.is_null() || Waiting() ||
        field_->GetText().empty()) {
      return false;
    }
    SecretBytes password = SecretBytes::FromUtf16(field_->GetText());
    field_->SetText(std::u16string());
    field_->SetEnabled(false);
    Answer(std::move(password));
    return false;
  }

  void Dismissed() { Answer(std::nullopt); }

  void Answer(std::optional<SecretBytes> password) {
    SetWaiting(true);
    if (answered_.is_null()) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(answered_), std::move(password)));
  }

  raw_ptr<views::Widget> widget_ = nullptr;
  raw_ptr<views::DialogDelegate> dialog_ = nullptr;
  raw_ptr<views::Textfield> field_ = nullptr;
  raw_ptr<views::Label> error_ = nullptr;
  Answered answered_;
  std::u16string said_;
  base::TimeTicks wait_until_;
  base::RepeatingTimer countdown_;
  base::ScopedObservation<views::Widget, views::WidgetObserver> observation_{
      this};
  base::WeakPtrFactory<WindowOwnerPrompt> weak_factory_{this};
};

class WindowOwnerPromptUi : public OwnerPromptUi {
 public:
  std::unique_ptr<OwnerPrompt> Ask(const std::string& reason,
                                   base::TimeDelta retry) override {
    return std::make_unique<WindowOwnerPrompt>(reason, retry);
  }

  void TellUnavailable(const std::string& reason,
                       base::OnceClosure dismissed) override {
    auto dialog = std::make_unique<views::DialogDelegate>();
    dialog->SetTitle(
        u"Ardia can't check your login password on this system.");
    dialog->SetShowCloseButton(false);
    dialog->set_fixed_width(kPromptWidth);
    dialog->SetButtons(static_cast<int>(ui::mojom::DialogButton::kOk));
    dialog->SetButtonLabel(ui::mojom::DialogButton::kOk, u"OK");
    dialog->SetContentsView(BodyLabel(
        base::UTF8ToUTF16("It needs your login password to " + reason + "."),
        views::style::STYLE_SECONDARY));
    dialog->RegisterWindowClosingCallback(std::move(dismissed));
    ShowDialog(std::move(dialog));
  }
};

}

std::unique_ptr<OwnerPromptUi> CreateWindowOwnerPromptUi() {
  return std::make_unique<WindowOwnerPromptUi>();
}

}
