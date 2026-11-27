#ifndef ARDIA_WIN_WEBUI_WEBUI_FILE_PICKER_H_
#define ARDIA_WIN_WEBUI_WEBUI_FILE_PICKER_H_

#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/values.h"
#include "ui/shell_dialogs/select_file_dialog.h"

namespace views {
class Widget;
}

namespace ardia_win::webui {

class FilePicker : public ui::SelectFileDialog::Listener {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  FilePicker();
  FilePicker(const FilePicker&) = delete;
  FilePicker& operator=(const FilePicker&) = delete;
  ~FilePicker() override;

  void PickFolder(views::Widget* owner, const base::ListValue* values, Done done);
  void PickFiles(views::Widget* owner, const base::ListValue* values, Done done);

 private:
  void FileSelected(const ui::SelectedFileInfo& file, int index) override;
  void MultiFilesSelected(
      const std::vector<ui::SelectedFileInfo>& files) override;
  void FileSelectionCanceled() override;

  bool Admit(Done& done);
  void Finish(base::Value value);

  scoped_refptr<ui::SelectFileDialog> dialog_;
  Done done_;
  bool folder_ = false;
};

}

#endif
