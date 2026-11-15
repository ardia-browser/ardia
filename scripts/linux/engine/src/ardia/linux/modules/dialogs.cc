// Copyright 2026 Ardia. Apache-2.0.

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/owner_window.h"
#include "ardia/linux/modules/test_answers.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/json/json_writer.h"
#include "base/memory/ref_counted.h"
#include "base/path_service.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/ui/select_file_policy/chrome_select_file_policy.h"
#include "chrome/common/chrome_paths.h"
#include "components/constrained_window/constrained_window_views.h"
#include "net/base/filename_util.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/base/mojom/ui_base_types.mojom.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/base/interaction/element_identifier.h"
#include "ui/base/models/dialog_model.h"
#include "ui/views/bubble/bubble_dialog_model_host.h"
#include "ui/views/widget/widget.h"
#include "ui/views/window/dialog_delegate.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaDialogs";

int g_open_count = 0;

struct DialogText {
  std::string title;
  std::string message;
  std::string confirm_title = "OK";
  std::string cancel_title = "Cancel";
  std::string suppression;
  std::string value;
  std::string placeholder;
  std::string window_id;
  bool destructive = false;
  bool prompt = false;

  static DialogText From(const base::DictValue* options, bool prompt) {
    DialogText text;
    text.prompt = prompt;
    if (!options) {
      return text;
    }
    auto read = [&](std::string_view key, std::string& into) {
      if (const std::string* found = options->FindString(key)) {
        into = *found;
      }
    };
    read("title", text.title);
    read("message", text.message);
    read("confirmTitle", text.confirm_title);
    read("cancelTitle", text.cancel_title);
    read("suppression", text.suppression);
    read("value", text.value);
    read("placeholder", text.placeholder);
    read("windowId", text.window_id);
    text.destructive = options->FindBool("destructive").value_or(false);
    return text;
  }

  base::DictValue Dumped() const {
    base::DictValue dumped;
    dumped.Set("kind", prompt ? "prompt" : "confirm");
    dumped.Set("title", title);
    dumped.Set("message", message);
    dumped.Set("confirmTitle", confirm_title);
    if (prompt) {
      dumped.Set("value", value);
      dumped.Set("placeholder", placeholder);
    } else {
      dumped.Set("cancelTitle", cancel_title);
      dumped.Set("destructive", destructive);
      if (!suppression.empty()) {
        dumped.Set("suppression", suppression);
      }
    }
    if (!window_id.empty()) {
      dumped.Set("windowId", window_id);
    }
    return dumped;
  }
};

struct DialogAnswer {
  bool confirmed = false;
  bool suppressed = false;
  std::string text;
};

using Answered = base::OnceCallback<void(DialogAnswer)>;

DEFINE_LOCAL_ELEMENT_IDENTIFIER_VALUE(kSuppressCheckbox);
DEFINE_LOCAL_ELEMENT_IDENTIFIER_VALUE(kPromptField);

class PendingAnswer : public base::RefCounted<PendingAnswer> {
 public:
  explicit PendingAnswer(Answered answered) : answered_(std::move(answered)) {}

  void set_model(ui::DialogModel* model) { model_ = model; }

  void Accept() {
    if (!answered_ || !model_) {
      return;
    }
    DialogAnswer answer;
    answer.confirmed = true;
    if (ui::DialogModelCheckbox* box =
            model_->GetCheckboxByUniqueId(kSuppressCheckbox)) {
      answer.suppressed = box->is_checked();
    }
    if (ui::DialogModelTextfield* field =
            model_->GetTextfieldByUniqueId(kPromptField)) {
      answer.text = base::UTF16ToUTF8(field->text());
    }
    Answer(std::move(answer));
  }

  void Decline() { Answer(DialogAnswer()); }

 private:
  friend class base::RefCounted<PendingAnswer>;
  ~PendingAnswer() = default;

  void Answer(DialogAnswer answer) {
    model_ = nullptr;
    if (answered_) {
      std::move(answered_).Run(std::move(answer));
    }
  }

  Answered answered_;
  raw_ptr<ui::DialogModel> model_ = nullptr;
};

void ShowAppDialog(const DialogText& text, Answered answered) {
  ++g_open_count;
  auto pending = base::MakeRefCounted<PendingAnswer>(base::BindOnce(
      [](Answered answered, DialogAnswer answer) {
        --g_open_count;
        std::move(answered).Run(std::move(answer));
      },
      std::move(answered)));
  const bool cancellable = text.prompt || !text.cancel_title.empty();
  ui::DialogModel::Builder builder;
  builder.SetTitle(base::UTF8ToUTF16(text.title));
  if (!text.message.empty()) {
    builder.AddParagraph(ui::DialogModelLabel(base::UTF8ToUTF16(text.message)));
  }
  if (text.prompt) {
    builder.AddTextfield(
        kPromptField, std::u16string(), base::UTF8ToUTF16(text.value),
        ui::DialogModelTextfield::Params().SetAccessibleName(
            base::UTF8ToUTF16(text.title)));
    builder.SetInitiallyFocusedField(kPromptField);
  }
  if (!text.suppression.empty()) {
    builder.AddCheckbox(kSuppressCheckbox,
                        ui::DialogModelLabel(base::UTF8ToUTF16(text.suppression)));
  }
  builder.AddOkButton(
      base::BindOnce(&PendingAnswer::Accept, pending),
      ui::DialogModel::Button::Params().SetLabel(
          base::UTF8ToUTF16(text.confirm_title)));
  if (cancellable) {
    builder.AddCancelButton(
        base::BindOnce(&PendingAnswer::Decline, pending),
        ui::DialogModel::Button::Params().SetLabel(base::UTF8ToUTF16(
            text.cancel_title.empty() ? std::string("Cancel")
                                      : text.cancel_title)));
    if (text.destructive) {
      builder.OverrideDefaultButton(ui::mojom::DialogButton::kCancel);
    }
  }
  builder.SetCloseActionCallback(base::BindOnce(&PendingAnswer::Decline, pending));
  builder.SetDialogDestroyingCallback(
      base::BindOnce(&PendingAnswer::Decline, pending));
  std::unique_ptr<ui::DialogModel> model = builder.Build();
  pending->set_model(model.get());
  views::Widget* owner = OwnerWidget(text.window_id);
  auto host = views::BubbleDialogModelHost::CreateModal(
      std::move(model), owner ? ui::mojom::ModalType::kWindow
                              : ui::mojom::ModalType::kNone);
  views::Widget* widget =
      owner ? constrained_window::CreateBrowserModalDialogViews(
                  std::move(host), owner->GetNativeWindow())
            : views::DialogDelegate::CreateDialogWidget(
                  std::move(host), gfx::NativeWindow(), gfx::NativeView());
  widget->Show();
}

int BackgroundPick(const DialogText& text) {
  std::vector<std::string> titles = {text.confirm_title};
  if (text.prompt || !text.cancel_title.empty()) {
    titles.push_back(text.cancel_title.empty() ? "Cancel" : text.cancel_title);
  }
  int pick = static_cast<int>(titles.size()) - 1;
  for (size_t i = 0; i < titles.size(); ++i) {
    if (titles[i] == "Cancel") {
      pick = static_cast<int>(i);
    }
  }
  NoteActivation(base::StrCat(
      {"alert (not shown): app-modal | \"", text.title, "\" | \"",
       text.message, "\" | buttons ", base::JoinString(titles, ", "),
       " | chose ", titles[pick]}));
  return pick;
}

void Ask(DialogText text, Answered answered) {
  const LaunchConfig& config = CurrentLaunchConfig();
  if (config.TestFlag("appDialog")) {
    DumpAndTakePick(
        "dialog.json",
        base::WriteJsonWithOptions(text.Dumped(),
                                   base::JSONWriter::OPTIONS_PRETTY_PRINT)
            .value_or("{}"),
        base::BindOnce(
            [](DialogText text, Answered answered,
               std::optional<std::string> pick) {
              if (!pick) {
                if (CurrentLaunchConfig().background) {
                  DialogAnswer answer;
                  answer.confirmed = BackgroundPick(text) == 0;
                  answer.text = text.value;
                  std::move(answered).Run(std::move(answer));
                  return;
                }
                ShowAppDialog(text, std::move(answered));
                return;
              }
              DialogAnswer answer;
              if (text.prompt) {
                answer.confirmed = !pick->empty();
                answer.text = *pick;
              } else {
                for (std::string_view word : base::SplitStringPiece(
                         *pick, ",", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
                  answer.confirmed |= word == "confirm";
                  answer.suppressed |= word == "suppress";
                }
              }
              std::move(answered).Run(std::move(answer));
            },
            std::move(text), std::move(answered)));
    return;
  }
  if (config.background) {
    DialogAnswer answer;
    answer.confirmed = BackgroundPick(text) == 0;
    answer.text = text.value;
    std::move(answered).Run(std::move(answer));
    return;
  }
  ShowAppDialog(text, std::move(answered));
}

class FilePicker : public ui::SelectFileDialog::Listener {
 public:
  using Picked = base::OnceCallback<void(std::vector<base::FilePath>)>;

  static void Run(ui::SelectFileDialog::Type type,
                  std::u16string title,
                  base::FilePath default_path,
                  std::optional<std::string> extension,
                  Picked picked) {
    auto* picker = new FilePicker(std::move(picked));
    picker->Start(type, title, default_path, extension);
  }

  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    Finish({file.path()});
  }

  void MultiFilesSelected(
      const std::vector<ui::SelectedFileInfo>& files) override {
    std::vector<base::FilePath> paths;
    for (const ui::SelectedFileInfo& file : files) {
      paths.push_back(file.path());
    }
    Finish(std::move(paths));
  }

  void FileSelectionCanceled() override { Finish({}); }

 private:
  explicit FilePicker(Picked picked) : picked_(std::move(picked)) {}
  ~FilePicker() override = default;

  void Start(ui::SelectFileDialog::Type type,
             const std::u16string& title,
             const base::FilePath& default_path,
             const std::optional<std::string>& extension) {
    ++g_open_count;
    dialog_ = ui::SelectFileDialog::Create(
        this, std::make_unique<ChromeSelectFilePolicy>(nullptr));
    ui::SelectFileDialog::FileTypeInfo types;
    if (extension && !extension->empty()) {
      types.extensions = {{*extension}};
      types.include_all_files = true;
    }
    views::Widget* owner = OwnerWidget();
    dialog_->SelectFile(
        type, title, default_path,
        extension && !extension->empty() ? &types : nullptr, 0,
        extension.value_or(std::string()),
        owner ? owner->GetNativeWindow() : gfx::NativeWindow());
  }

  void Finish(std::vector<base::FilePath> paths) {
    --g_open_count;
    dialog_->ListenerDestroyed();
    std::move(picked_).Run(std::move(paths));
    delete this;
  }

  Picked picked_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

void ReplyPaths(ModuleReply reply,
                bool as_urls,
                bool first_only,
                std::vector<base::FilePath> paths) {
  if (first_only) {
    std::move(reply).Run(paths.empty() ? base::Value()
                                       : base::Value(paths.front().value()));
    return;
  }
  base::ListValue list;
  for (const base::FilePath& path : paths) {
    list.Append(as_urls ? net::FilePathToFileURL(path).spec() : path.value());
  }
  std::move(reply).Run(base::Value(std::move(list)));
}

void FromBackgroundPicks(std::string panel,
                         FilePicker::Picked picked,
                         bool name_picks) {
  TakeFileChooserPicks(base::BindOnce(
      [](std::string panel, FilePicker::Picked picked, bool name_picks,
         std::vector<std::string> picks) {
        std::string outcome = "cancelled";
        if (!picks.empty()) {
          outcome = name_picks ? base::StrCat({"chose ",
                                               base::JoinString(picks, ", ")})
                               : std::string("chose a file");
        }
        NoteActivation(base::StrCat({panel, " | ", outcome}));
        std::vector<base::FilePath> paths;
        for (const std::string& pick : picks) {
          paths.emplace_back(pick);
        }
        std::move(picked).Run(std::move(paths));
      },
      std::move(panel), std::move(picked), name_picks));
}

base::FilePath DownloadsFolder() {
  base::FilePath downloads;
  base::PathService::Get(chrome::DIR_DEFAULT_DOWNLOADS, &downloads);
  return downloads;
}

void PickFiles(base::ListValue, ModuleReply reply) {
  FilePicker::Picked picked =
      base::BindOnce(&ReplyPaths, std::move(reply), true, false);
  if (CurrentLaunchConfig().background) {
    FromBackgroundPicks(
        "open panel (not shown): free-standing | multiple=1 files=1 "
        "directories=0 | types=* others=1",
        std::move(picked), true);
    return;
  }
  FilePicker::Run(ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE,
                  std::u16string(), base::FilePath(), std::nullopt,
                  std::move(picked));
}

void PickFolder(base::ListValue args, ModuleReply reply) {
  const std::optional<std::string> current = OptionalStringArg(args, 0);
  FilePicker::Picked picked =
      base::BindOnce(&ReplyPaths, std::move(reply), false, true);
  if (CurrentLaunchConfig().background) {
    FromBackgroundPicks(
        base::StrCat({"open panel (not shown): free-standing | multiple=0 "
                      "files=0 directories=1 | types=* others=1",
                      current ? " | directory=" + *current : std::string()}),
        std::move(picked), true);
    return;
  }
  FilePicker::Run(ui::SelectFileDialog::SELECT_FOLDER, u"Choose Folder",
                  current ? base::FilePath(*current) : base::FilePath(),
                  std::nullopt, std::move(picked));
}

void SaveFile(base::ListValue args, ModuleReply reply) {
  std::string name = StringArg(args, 0);
  const std::string extension = StringArg(args, 1);
  const std::string kind = StringArg(args, 2);
  FilePicker::Picked picked =
      base::BindOnce(&ReplyPaths, std::move(reply), false, true);
  if (CurrentLaunchConfig().background) {
    FromBackgroundPicks(
        base::StrCat({"save panel (not shown): name=", name,
                      " extension=", extension, " kind=", kind}),
        std::move(picked), false);
    return;
  }
  if (!extension.empty() && !base::EndsWith(name, "." + extension)) {
    name += "." + extension;
  }
  FilePicker::Run(ui::SelectFileDialog::SELECT_SAVEAS_FILE, std::u16string(),
                  DownloadsFolder().Append(name),
                  extension.empty() ? std::nullopt
                                    : std::optional<std::string>(extension),
                  std::move(picked));
}

}

void ConfirmWithUser(const base::DictValue& options,
                     base::OnceCallback<void(bool, bool)> done) {
  Ask(DialogText::From(&options, false),
      base::BindOnce(
          [](base::OnceCallback<void(bool, bool)> done, DialogAnswer answer) {
            std::move(done).Run(answer.confirmed, answer.suppressed);
          },
          std::move(done)));
}

void RegisterDialogsModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Sync("openCount", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(g_open_count));
            }))
      .Async("confirm", AsyncOf([](base::ListValue args, ModuleReply reply) {
               Ask(DialogText::From(DictArg(args, 0), false),
                   base::BindOnce(
                       [](ModuleReply reply, DialogAnswer answer) {
                         base::DictValue result;
                         result.Set("confirmed", answer.confirmed);
                         result.Set("suppressed", answer.suppressed);
                         std::move(reply).Run(base::Value(std::move(result)));
                       },
                       std::move(reply)));
             }))
      .Async("prompt", AsyncOf([](base::ListValue args, ModuleReply reply) {
               Ask(DialogText::From(DictArg(args, 0), true),
                   base::BindOnce(
                       [](ModuleReply reply, DialogAnswer answer) {
                         std::string text(base::TrimWhitespaceASCII(
                             answer.text, base::TRIM_ALL));
                         std::move(reply).Run(
                             answer.confirmed && !text.empty()
                                 ? base::Value(std::move(text))
                                 : base::Value());
                       },
                       std::move(reply)));
             }))
      .Async("pickFiles", base::BindRepeating(&PickFiles))
      .Async("pickFolder", base::BindRepeating(&PickFolder))
      .Async("saveFile", base::BindRepeating(&SaveFile))
      .Async("devHoldConfirm", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(false));
             }))
      .Async("devReleaseDialogs", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value());
             }));
}

}
