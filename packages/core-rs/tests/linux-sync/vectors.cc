#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "ardia/linux/ac_linux_sync_keys.h"

using namespace ardia::linux_sync;

namespace {

Bytes FromHex(const std::string& text) {
  Bytes out;
  if (text == "-") return out;
  for (size_t i = 0; i + 1 < text.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoi(text.substr(i, 2), nullptr, 16)));
  return out;
}

std::string Text(const std::string& hex) {
  Bytes bytes = FromHex(hex);
  return std::string(bytes.begin(), bytes.end());
}

std::string Hex(const uint8_t* data, size_t size) {
  if (size == 0) return "-";
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < size; ++i) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 15]);
  }
  return out;
}

std::string Hex(const std::string& text) { return Hex(reinterpret_cast<const uint8_t*>(text.data()), text.size()); }

std::string Hex(const Bytes& bytes) { return Hex(bytes.data(), bytes.size()); }

std::string OpenResult(OpenError error, const std::string& payload_hex) {
  if (error == OpenError::kNone) return "ok " + payload_hex;
  return std::string(OpenFailureCode(error));
}

std::string Run(const std::string& line) {
  std::istringstream in(line);
  std::string command;
  in >> command;
  std::vector<std::string> args;
  for (std::string arg; in >> arg;) args.push_back(arg);
  if (command == "phrase" && args.size() == 1) {
    std::string joined;
    for (const auto& word : PhraseWords(FromHex(args[0]))) joined += (joined.empty() ? "" : " ") + word;
    return Hex(joined);
  }
  if (command == "tokens" && args.size() == 1) {
    std::string out;
    for (const auto& token : PhraseTokens(Text(args[0]))) out += (out.empty() ? "" : " ") + Hex(token);
    return out.empty() ? "-" : out;
  }
  if (command == "entropy" && args.size() == 1) {
    Bytes entropy;
    const PhraseProblem problem = EntropyFromPhrase(Text(args[0]), &entropy);
    switch (problem.kind) {
      case PhraseProblem::Kind::kNone:
        return "ok " + Hex(entropy);
      case PhraseProblem::Kind::kWordCount:
        return "wordCount " + std::to_string(problem.count);
      case PhraseProblem::Kind::kUnknownWord:
        return "unknownWord " + Hex(problem.word);
      case PhraseProblem::Kind::kChecksum:
        return "checksum";
    }
  }
  const auto keys = args.empty() ? nullptr : SyncKeys::Make(FromHex(args[0]));
  if (!keys) return "keys";
  if (command == "tags" && args.size() == 2) return keys->chain_tag() + " " + keys->ScopeTag(Text(args[1]));
  if (command == "seal" && args.size() == 4) {
    const Bytes payload = FromHex(args[3]);
    const auto sealed = keys->Seal(payload, Text(args[1]), Text(args[2]));
    if (!sealed) return "error";
    Bytes opened;
    const OpenError error = keys->Open(*sealed, Text(args[1]), Text(args[2]), &opened);
    return std::to_string(sealed->size()) + " " + OpenResult(error, Hex(opened));
  }
  if (command == "open" && args.size() == 4) {
    Bytes payload;
    const OpenError error = keys->Open(FromHex(args[3]), Text(args[1]), Text(args[2]), &payload);
    return OpenResult(error, Hex(payload));
  }
  if (command == "sealpw" && args.size() == 4) {
    const auto sealed = keys->SealPassword(Text(args[1]), Text(args[2]), Text(args[3]));
    return sealed ? *sealed : "error";
  }
  if (command == "openpw" && args.size() == 4) {
    std::string password;
    const OpenError error = keys->OpenPassword(Text(args[1]), Text(args[2]), Text(args[3]), &password);
    return OpenResult(error, Hex(password));
  }
  return "unknown";
}

}

int main() {
  for (std::string line; std::getline(std::cin, line);) std::cout << Run(line) << "\n";
  return 0;
}
