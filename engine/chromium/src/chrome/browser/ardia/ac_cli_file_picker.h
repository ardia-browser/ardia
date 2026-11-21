// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_FILE_PICKER_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_FILE_PICKER_H_

#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardia {

enum class FilePickerKind { kOpen, kSave, kDirectory };

std::string ArmFilePickerAnswer(content::WebContents* contents,
                                const base::DictValue& params,
                                const void* owner);
void ForgetFilePickerAnswers(const void* owner);
void InstallFilePickerAnswers();
base::DictValue FilePickerAnswerTotals();

}

#endif
