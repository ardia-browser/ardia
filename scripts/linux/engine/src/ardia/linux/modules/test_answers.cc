// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/test_answers.h"

#include <utility>

#include "ardia/linux/log.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"

namespace ardia_linux {

namespace {

std::vector<std::string> ReadPicks(base::FilePath file) {
  std::string text;
  if (!base::ReadFileToString(file, &text)) {
    return {};
  }
  base::DeleteFile(file);
  return base::SplitString(text, "\r\n", base::TRIM_WHITESPACE,
                           base::SPLIT_WANT_NONEMPTY);
}

std::optional<std::string> DumpThenRead(base::FilePath file,
                                        std::string dumped) {
  base::WriteFile(file, dumped);
  const base::FilePath pick_file = file.AddExtension("pick");
  std::string pick;
  if (!base::ReadFileToString(pick_file, &pick)) {
    return std::nullopt;
  }
  base::DeleteFile(pick_file);
  return std::string(base::TrimWhitespaceASCII(pick, base::TRIM_ALL));
}

}

void TakeFileChooserPicks(
    base::OnceCallback<void(std::vector<std::string>)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ReadPicks, DataDirectory().Append("file-chooser.txt")),
      std::move(done));
}

void DumpAndTakePick(
    std::string file_name,
    std::string dumped,
    base::OnceCallback<void(std::optional<std::string>)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&DumpThenRead, DataDirectory().Append(file_name),
                     std::move(dumped)),
      std::move(done));
}

}
