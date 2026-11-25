#include "ardia/win/webui/webui_file_picker.h"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/main.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "base/files/file_path.h"
#include "base/logging.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/ui/select_file_policy/chrome_select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/views/widget/widget.h"

namespace ardia_win::webui {

namespace {

base::Value PickerFailure(std::string_view code, std::string_view message) {
  return base::Value(
      base::DictValue().Set("code", code).Set("message", message));
}

}

FilePicker::FilePicker() = default;

FilePicker::~FilePicker() {
  if (dialog_) {
    dialog_->ListenerDestroyed();
  }
  if (done_) {
    std::move(done_).Run(false, PickerFailure("ERR_PICKER_CLOSED",
                                              "The window closed"));
  }
}

bool FilePicker::Admit(Done& done) {
  if (done_) {
    std::move(done).Run(false, PickerFailure("ERR_PICKER_OPEN",
                                             "A file dialog is already open in "
                                             "this window"));
    return false;
  }
  if (!ChromeSelectFilePolicy::FileSelectDialogsAllowed()) {
    std::move(done).Run(false, PickerFailure("ERR_FILE_CHOOSER_DISABLED",
                                             "File choosers are disabled by "
                                             "policy"));
    return false;
  }
  return true;
}

void FilePicker::PickFolder(views::Widget* owner,
                            const base::ListValue* values,
                            Done done) {
  if (values &&
      (values->size() > 2 ||
       std::ranges::any_of(*values, [](const base::Value& value) {
         return !value.is_string() && !value.is_none();
       }))) {
    return std::move(done).Run(
        false, PickerFailure("ERR_FOLDER_REQUEST",
                             "A current folder and button title, or null, are "
                             "expected"));
  }
  if (ardiacore::BackgroundInstance()) {
    NoteForTest("webui shell: folder picker requested in the background");
    return std::move(done).Run(true, base::Value());
  }
  if (!Admit(done)) {
    return;
  }
  const std::string current =
      values && !values->empty() && (*values)[0].is_string()
          ? (*values)[0].GetString()
          : std::string();
  const std::string prompt =
      values && values->size() == 2 && (*values)[1].is_string()
          ? (*values)[1].GetString()
          : std::string();
  const std::u16string title = webui_window::PickerPromptUsable(prompt)
                                   ? base::UTF8ToUTF16(prompt)
                                   : std::u16string(u"Choose a Folder");
  const base::FilePath start = base::IsStringUTF8(current) && !current.empty()
                                   ? base::FilePath(base::UTF8ToWide(current))
                                   : base::FilePath();
  folder_ = true;
  done_ = std::move(done);
  dialog_ = ui::SelectFileDialog::Create(
      this, std::make_unique<ChromeSelectFilePolicy>(nullptr));
  dialog_->SelectFile(ui::SelectFileDialog::SELECT_FOLDER, title,
                      start.IsAbsolute() ? start : base::FilePath(), nullptr, 0,
                      base::FilePath::StringType(),
                      owner ? owner->GetNativeWindow() : gfx::NativeWindow());
}

void FilePicker::PickFiles(views::Widget* owner,
                           const base::ListValue* values,
                           Done done) {
  if (values && !values->empty()) {
    return std::move(done).Run(
        false, PickerFailure("ERR_FILES_REQUEST",
                             "Choosing files to open takes no arguments"));
  }
  if (ardiacore::BackgroundInstance()) {
    NoteForTest("webui shell: file picker requested in the background");
    return std::move(done).Run(true, base::Value(base::ListValue()));
  }
  if (!Admit(done)) {
    return;
  }
  folder_ = false;
  done_ = std::move(done);
  dialog_ = ui::SelectFileDialog::Create(
      this, std::make_unique<ChromeSelectFilePolicy>(nullptr));
  dialog_->SelectFile(ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE,
                      std::u16string(), base::FilePath(), nullptr, 0,
                      base::FilePath::StringType(),
                      owner ? owner->GetNativeWindow() : gfx::NativeWindow());
}

void FilePicker::FileSelected(const ui::SelectedFileInfo& file, int index) {
  if (folder_) {
    return Finish(base::Value(file.file_path.AsUTF8Unsafe()));
  }
  Finish(base::Value(base::ListValue().Append(file.file_path.AsUTF8Unsafe())));
}

void FilePicker::MultiFilesSelected(
    const std::vector<ui::SelectedFileInfo>& files) {
  if (folder_) {
    return Finish(files.empty() ? base::Value()
                                : base::Value(files[0].file_path.AsUTF8Unsafe()));
  }
  base::ListValue paths;
  for (const ui::SelectedFileInfo& file : files) {
    paths.Append(file.file_path.AsUTF8Unsafe());
  }
  Finish(base::Value(std::move(paths)));
}

void FilePicker::FileSelectionCanceled() {
  Finish(folder_ ? base::Value() : base::Value(base::ListValue()));
}

void FilePicker::Finish(base::Value value) {
  dialog_ = nullptr;
  if (done_) {
    std::move(done_).Run(true, std::move(value));
  }
}

}
