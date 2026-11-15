// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_SYNC_SYNC_PHRASE_H_
#define ARDIA_LINUX_SYNC_SYNC_PHRASE_H_

#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include "ardia/linux/sync/sync_crypto.h"

namespace ardia_linux::sync {

inline constexpr size_t kWordCount = 24;

const std::vector<std::string_view>& EnglishWords();

struct PhraseProblem {
  std::string error;
  size_t count = 0;
  std::string word;
};

std::optional<std::vector<std::string>> WordsFor(std::string_view entropy);

std::vector<Secret> PhraseTokens(std::string_view text);

std::variant<Secret, PhraseProblem> EntropyFrom(std::string_view text);

}

#endif
