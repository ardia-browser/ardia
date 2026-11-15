// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/sync/sync_phrase.h"

#include <map>

#include "base/i18n/case_conversion.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversion_utils.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/icu/source/common/unicode/uchar.h"

namespace ardia_linux::sync {

namespace {

const std::map<std::string_view, size_t>& Lookup() {
  static const base::NoDestructor<std::map<std::string_view, size_t>> lookup(
      [] {
        std::map<std::string_view, size_t> built;
        const auto& words = EnglishWords();
        for (size_t i = 0; i < words.size(); ++i) {
          built.emplace(words[i], i);
        }
        return built;
      }());
  return *lookup;
}

const std::map<std::string_view, size_t>& Prefixes() {
  static const base::NoDestructor<std::map<std::string_view, size_t>> prefixes(
      [] {
        std::map<std::string_view, size_t> built;
        const auto& words = EnglishWords();
        for (size_t i = 0; i < words.size(); ++i) {
          built[words[i].substr(0, 4)] = i;
        }
        return built;
      }());
  return *prefixes;
}

size_t CodePoints(std::string_view text) {
  size_t count = 0;
  for (char c : text) {
    if ((static_cast<uint8_t>(c) & 0xc0) != 0x80) {
      ++count;
    }
  }
  return count;
}

std::optional<size_t> IndexOf(const std::string& token) {
  auto exact = Lookup().find(token);
  if (exact != Lookup().end()) {
    return exact->second;
  }
  if (CodePoints(token) < 4) {
    return std::nullopt;
  }
  auto prefixed = Prefixes().find(std::string_view(token).substr(0, 4));
  if (prefixed == Prefixes().end()) {
    return std::nullopt;
  }
  std::string_view word = EnglishWords()[prefixed->second];
  return word.starts_with(token) ? std::optional<size_t>(prefixed->second)
                                 : std::nullopt;
}

}

std::optional<std::vector<std::string>> WordsFor(std::string_view entropy) {
  if (entropy.size() != kKeyBytes) {
    return std::nullopt;
  }
  Secret bits{std::string(entropy)};
  bits.str().push_back(Sha256(entropy)[0]);
  std::vector<std::string> words;
  for (size_t word = 0; word < kWordCount; ++word) {
    size_t index = 0;
    for (size_t bit = word * 11; bit < word * 11 + 11; ++bit) {
      index = (index << 1) |
              ((static_cast<uint8_t>(bits.view()[bit / 8]) >> (7 - bit % 8)) &
               1);
    }
    words.emplace_back(EnglishWords()[index]);
  }
  return words;
}

std::vector<Secret> PhraseTokens(std::string_view text) {
  std::u16string wide = base::UTF8ToUTF16(text);
  std::u16string lower = base::i18n::ToLower(wide);
  std::vector<Secret> tokens;
  std::string current;
  auto finish = [&] {
    if (!current.empty()) {
      tokens.emplace_back(std::move(current));
    }
    current = std::string();
  };
  size_t at = 0;
  while (at < lower.size()) {
    base_icu::UChar32 point = 0;
    size_t index = at;
    if (!base::ReadUnicodeCharacter(std::u16string_view(lower), &index,
                                    &point)) {
      finish();
      at = index + 1;
      continue;
    }
    if (u_islower(point)) {
      base::WriteUnicodeCharacter(point, &current);
    } else {
      finish();
    }
    at = index + 1;
  }
  finish();
  std::fill(lower.begin(), lower.end(), u'\0');
  std::fill(wide.begin(), wide.end(), u'\0');
  return tokens;
}

std::variant<Secret, PhraseProblem> EntropyFrom(std::string_view text) {
  std::vector<Secret> tokens = PhraseTokens(text);
  if (tokens.size() != kWordCount) {
    return PhraseProblem{"wordCount", tokens.size(), {}};
  }
  Secret bits(std::string(kWordCount * 11 / 8, '\0'));
  for (size_t word = 0; word < kWordCount; ++word) {
    std::optional<size_t> index = IndexOf(tokens[word].str());
    if (!index) {
      return PhraseProblem{"unknownWord", 0, tokens[word].str()};
    }
    for (size_t bit = 0; bit < 11; ++bit) {
      const size_t at = word * 11 + bit;
      if ((*index >> (10 - bit)) & 1) {
        bits.str()[at / 8] = static_cast<char>(
            static_cast<uint8_t>(bits.str()[at / 8]) | (1 << (7 - at % 8)));
      }
    }
  }
  Secret entropy{std::string(bits.view().substr(0, kKeyBytes))};
  if (Sha256(entropy.view())[0] != bits.view()[kKeyBytes]) {
    return PhraseProblem{"checksum", 0, {}};
  }
  return entropy;
}

}
