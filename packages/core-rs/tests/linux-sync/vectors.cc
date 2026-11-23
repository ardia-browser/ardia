#include <cstdio>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "ardia/linux/ac_linux_sync_crypto.h"

namespace sync = ardia::linux_sync;

namespace {

sync::Bytes FromHex(const std::string& text) {
  sync::Bytes out;
  if (text == "-") return out;
  for (size_t i = 0; i + 1 < text.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoi(text.substr(i, 2), nullptr, 16)));
  return out;
}

std::string Text(const std::string& hex) {
  sync::Bytes bytes = FromHex(hex);
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

std::string Hex(const sync::Bytes& bytes) { return Hex(bytes.data(), bytes.size()); }

std::string OpenResult(sync::OpenError error, const std::string& payload_hex) {
  if (error == sync::OpenError::kFormat) return "format";
  if (error == sync::OpenError::kAuthentication) return "authentication";
  return "ok " + payload_hex;
}

std::string Run(const std::string& line) {
  std::istringstream in(line);
  std::string command;
  in >> command;
  std::vector<std::string> args;
  for (std::string arg; in >> arg;) args.push_back(arg);
  if (command == "phrase" && args.size() == 1) {
    std::string joined;
    for (const auto& word : sync::PhraseWords(FromHex(args[0]))) joined += (joined.empty() ? "" : " ") + word;
    return Hex(joined);
  }
  if (command == "tokens" && args.size() == 1) {
    std::string out;
    for (const auto& token : sync::PhraseTokens(Text(args[0]))) out += (out.empty() ? "" : " ") + Hex(token);
    return out.empty() ? "-" : out;
  }
  if (command == "entropy" && args.size() == 1) {
    sync::Bytes entropy;
    const sync::PhraseProblem problem = sync::EntropyFromPhrase(Text(args[0]), &entropy);
    switch (problem.kind) {
      case sync::PhraseProblem::Kind::kNone:
        return "ok " + Hex(entropy);
      case sync::PhraseProblem::Kind::kWordCount:
        return "wordCount " + std::to_string(problem.count);
      case sync::PhraseProblem::Kind::kUnknownWord:
        return "unknownWord " + Hex(problem.word);
      case sync::PhraseProblem::Kind::kChecksum:
        return "checksum";
    }
  }
  if (command == "tags" && args.size() == 2) {
    sync::SyncKeys keys(FromHex(args[0]));
    return keys.chain_tag() + " " + keys.ScopeTag(Text(args[1]));
  }
  if (command == "seal" && args.size() == 5) {
    sync::SyncKeys keys(FromHex(args[0]));
    const sync::Bytes nonce = FromHex(args[3]);
    if (nonce.size() != sync::kNonceBytes) return "error";
    const auto sealed = keys.SealWithNonce(FromHex(args[4]), Text(args[1]), Text(args[2]), nonce.data());
    return sealed ? Hex(*sealed) : "error";
  }
  if (command == "open" && args.size() == 4) {
    sync::SyncKeys keys(FromHex(args[0]));
    sync::Bytes payload;
    const sync::OpenError error = keys.Open(FromHex(args[3]), Text(args[1]), Text(args[2]), &payload);
    return OpenResult(error, Hex(payload));
  }
  if (command == "sealpw" && args.size() == 4) {
    sync::SyncKeys keys(FromHex(args[0]));
    const auto sealed = keys.SealPassword(Text(args[1]), Text(args[2]), Text(args[3]));
    return sealed ? *sealed : "error";
  }
  if (command == "openpw" && args.size() == 4) {
    sync::SyncKeys keys(FromHex(args[0]));
    std::string password;
    const sync::OpenError error = keys.OpenPassword(Text(args[1]), Text(args[2]), Text(args[3]), &password);
    return OpenResult(error, Hex(password));
  }
  return "unknown";
}

}

int main() {
  for (std::string line; std::getline(std::cin, line);) std::cout << Run(line) << "\n";
  return 0;
}
