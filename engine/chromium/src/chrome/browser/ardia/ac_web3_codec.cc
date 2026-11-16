// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_web3_codec.h"

#include <array>
#include <utility>

namespace ardia::web3 {
namespace {

constexpr size_t kWord = 32;

std::vector<std::string_view> Split(std::string_view text, char separator) {
  std::vector<std::string_view> parts;
  size_t start = 0;
  while (true) {
    const size_t end = text.find(separator, start);
    if (end == std::string_view::npos) {
      parts.push_back(text.substr(start));
      return parts;
    }
    parts.push_back(text.substr(start, end - start));
    start = end + 1;
  }
}

std::vector<std::string_view> PathSegments(std::string_view path) {
  if (!path.empty() && path.front() == '/') path.remove_prefix(1);
  std::vector<std::string_view> segments = Split(path, '/');
  if (!segments.empty() && segments.back().empty()) segments.pop_back();
  return segments;
}

std::string Lower(std::string_view text) {
  std::string lower(text);
  for (char& c : lower) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return lower;
}

std::optional<Bytes> DecimalWord(std::string_view digits) {
  if (!IsDecimal(digits)) return std::nullopt;
  std::array<unsigned, kWord> word{};
  for (char c : digits) {
    unsigned carry = static_cast<unsigned>(c - '0');
    for (size_t i = kWord; i-- > 0;) {
      const unsigned value = word[i] * 10 + carry;
      word[i] = value & 0xff;
      carry = value >> 8;
    }
    if (carry) return std::nullopt;
  }
  Bytes out(kWord, '\0');
  for (size_t i = 0; i < kWord; ++i) out[i] = static_cast<char>(word[i]);
  return out;
}

bool FitsBits(std::string_view word, int bits) {
  const size_t free_bits = 256 - bits;
  for (size_t bit = 0; bit < free_bits; ++bit) {
    if (static_cast<unsigned char>(word[bit / 8]) & (0x80 >> (bit % 8))) {
      return false;
    }
  }
  return true;
}

bool IsPowerOfTwoBit(std::string_view word, int bit_from_right) {
  for (size_t i = 0; i < kWord; ++i) {
    const unsigned char expected =
        static_cast<int>(kWord - 1 - i) == bit_from_right / 8
            ? static_cast<unsigned char>(1u << (bit_from_right % 8))
            : 0;
    if (static_cast<unsigned char>(word[i]) != expected) return false;
  }
  return true;
}

std::optional<AbiType> ScalarType(std::string_view name) {
  std::optional<AbiType> tuple = ParseAbiType("(" + std::string(name) + ")");
  if (!tuple || tuple->items.size() != 1 ||
      tuple->items[0].kind == AbiType::Kind::kArray ||
      tuple->items[0].kind == AbiType::Kind::kTuple) {
    return std::nullopt;
  }
  return tuple->items[0];
}

std::optional<int> StatusOf(std::string_view word) {
  if (word.substr(0, kWord - 2).find_first_not_of('\0') != std::string_view::npos) {
    return std::nullopt;
  }
  const int status = static_cast<unsigned char>(word[kWord - 2]) * 256 +
                     static_cast<unsigned char>(word[kWord - 1]);
  if (status < 100 || status > 999) return std::nullopt;
  return status;
}

struct Argument {
  AbiType type;
  AbiValue value;
};

std::variant<Argument, std::string> ParseArgument(std::string_view raw) {
  std::string_view type_name;
  std::string_view value = raw;
  const size_t bang = raw.find('!');
  if (bang != std::string_view::npos && ScalarType(raw.substr(0, bang))) {
    type_name = raw.substr(0, bang);
    value = raw.substr(bang + 1);
  }
  if (type_name.empty()) {
    if (IsDecimal(value)) {
      type_name = "uint256";
    } else if (std::optional<Bytes> bytes = FromHex(value)) {
      type_name = bytes->size() == 32   ? "bytes32"
                  : bytes->size() == 20 ? "address"
                                        : "bytes";
    } else if (value == "true" || value == "false") {
      type_name = "bool";
    } else {
      return std::string("Names as arguments aren't supported yet: ") +
             std::string(value);
    }
  }
  Argument argument{*ScalarType(type_name), {}};
  const std::string bad = "Not a valid " + Signature(argument.type) + ": " +
                          std::string(value);
  switch (argument.type.kind) {
    case AbiType::Kind::kBool:
      if (value != "true" && value != "false") return bad;
      argument.value = AbiWord(Bytes(kWord - 1, '\0') + (value == "true" ? '\1' : '\0'));
      break;
    case AbiType::Kind::kUint: {
      std::optional<Bytes> word = DecimalWord(value);
      if (!word || !FitsBits(*word, argument.type.size)) return bad;
      argument.value = AbiWord(std::move(*word));
      break;
    }
    case AbiType::Kind::kInt: {
      const bool negative = !value.empty() && value[0] == '-';
      std::optional<Bytes> word = DecimalWord(negative ? value.substr(1) : value);
      if (!word) return bad;
      const bool fits = FitsBits(*word, argument.type.size - 1) ||
                        (negative && IsPowerOfTwoBit(*word, argument.type.size - 1));
      if (!fits) return bad;
      argument.value = AbiWord(negative ? Negate(*word) : std::move(*word));
      break;
    }
    case AbiType::Kind::kAddress: {
      std::optional<Bytes> address = ParseAddress(value);
      if (!address) {
        return std::string("Names as arguments aren't supported yet: ") +
               std::string(value);
      }
      argument.value = AbiWord(Bytes(12, '\0') + *address);
      break;
    }
    case AbiType::Kind::kFixedBytes: {
      std::optional<Bytes> bytes = FromHex(value);
      if (!bytes || static_cast<int>(bytes->size()) != argument.type.size) {
        return bad;
      }
      bytes->resize(kWord, '\0');
      argument.value = AbiWord(std::move(*bytes));
      break;
    }
    case AbiType::Kind::kBytes: {
      std::optional<Bytes> bytes = FromHex(value);
      if (!bytes) return bad;
      argument.value = AbiBytes(std::move(*bytes));
      break;
    }
    case AbiType::Kind::kString:
      argument.value = AbiBytes(Bytes(value));
      break;
    default:
      return bad;
  }
  return argument;
}

std::string FileExtension(std::string_view text) {
  const size_t dot = text.rfind('.');
  if (dot == std::string_view::npos || dot + 1 == text.size()) return "";
  std::string_view extension = text.substr(dot + 1);
  for (char c : extension) {
    const bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                       (c >= 'A' && c <= 'Z');
    if (!alnum) return "";
  }
  return Lower(extension);
}

bool IsMethodName(std::string_view name) {
  if (name.empty()) return false;
  for (size_t i = 0; i < name.size(); ++i) {
    const char c = name[i];
    const bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                        c == '$' || c == '_';
    if (!letter && (i == 0 || c < '0' || c > '9')) return false;
  }
  return true;
}

std::optional<uint64_t> ChainOfShortName(std::string_view name) {
  static constexpr std::pair<std::string_view, uint64_t> kChains[] = {
      {"eth", 1},     {"sep", 11155111}, {"holesky", 17000}, {"oeth", 10},
      {"arb1", 42161}, {"base", 8453},   {"pol", 137},       {"matic", 137},
  };
  for (const auto& [short_name, chain] : kChains) {
    if (name == short_name) return chain;
  }
  return std::nullopt;
}

const AbiType& ResourceRequestType() {
  static const AbiType type = *ParseAbiType("(string[],(string,string)[])");
  return type;
}

const AbiType& ResourceResponseType() {
  static const AbiType type = *ParseAbiType("(uint256,string,(string,string)[])");
  return type;
}

const AbiType& BytesType() {
  static const AbiType type = *ParseAbiType("(bytes)");
  return type;
}

}

Bytes NameHash(std::string_view name) {
  Bytes node(kWord, '\0');
  if (name.empty()) return node;
  std::vector<std::string_view> labels = Split(name, '.');
  for (size_t i = labels.size(); i-- > 0;) {
    node = Keccak256(node + Keccak256(labels[i]));
  }
  return node;
}

Mode ModeFromResolveMode(std::optional<std::string_view> returned) {
  if (!returned || returned->empty()) return Mode::kAuto;
  if (returned->size() < kWord) return Mode::kUnsupported;
  std::string_view word = returned->substr(0, kWord);
  const size_t end = word.find('\0');
  std::string_view name = word.substr(0, end);
  if (end != std::string_view::npos &&
      word.find_first_not_of('\0', end) != std::string_view::npos) {
    return Mode::kUnsupported;
  }
  const std::string mode = Lower(name);
  if (mode.empty() || mode == "auto") return Mode::kAuto;
  if (mode == "5219") return Mode::kResource;
  if (mode == "manual") return Mode::kManual;
  return Mode::kUnsupported;
}

std::optional<Host> ParseHost(std::string_view host) {
  if (std::optional<Bytes> address = ParseAddress(host)) {
    return Host{std::move(*address), ""};
  }
  std::vector<std::string_view> labels = Split(host, '.');
  if (labels.size() < 2 || labels.back() != "eth") return std::nullopt;
  for (std::string_view label : labels) {
    if (label.empty()) return std::nullopt;
  }
  return Host{std::nullopt, std::string(host)};
}

std::optional<ContentContract> ParseContentContract(std::string_view record) {
  while (!record.empty() && (record.front() == ' ' || record.front() == '\n')) {
    record.remove_prefix(1);
  }
  while (!record.empty() && (record.back() == ' ' || record.back() == '\n')) {
    record.remove_suffix(1);
  }
  ContentContract contract;
  const size_t colon = record.find(':');
  if (colon != std::string_view::npos) {
    contract.chain_id = ChainOfShortName(Lower(record.substr(0, colon)));
    if (!contract.chain_id) return std::nullopt;
    record = record.substr(colon + 1);
  }
  std::optional<Bytes> address = ParseAddress(record);
  if (!address) return std::nullopt;
  contract.address = std::move(*address);
  return contract;
}

Bytes ResourceRequestCall(std::string_view path, std::string_view query) {
  std::vector<AbiValue> resource;
  for (std::string_view segment : PathSegments(path)) {
    resource.push_back(AbiBytes(PercentDecode(segment, false)));
  }
  std::vector<AbiValue> params;
  if (!query.empty()) {
    for (std::string_view pair : Split(query, '&')) {
      if (pair.empty()) continue;
      const size_t equals = pair.find('=');
      std::string_view key = pair.substr(0, equals);
      std::string_view value =
          equals == std::string_view::npos ? "" : pair.substr(equals + 1);
      params.push_back(AbiList({AbiBytes(PercentDecode(key, true)),
                                AbiBytes(PercentDecode(value, true))}));
    }
  }
  return Selector("request(string[],(string,string)[])") +
         AbiEncode(ResourceRequestType(),
                   {AbiList(std::move(resource)), AbiList(std::move(params))});
}

std::optional<Resource> DecodeResource(std::string_view returned) {
  std::optional<std::vector<AbiValue>> values =
      AbiDecode(ResourceResponseType(), returned);
  if (!values) return std::nullopt;
  std::optional<int> status = StatusOf((*values)[0].data);
  if (!status) return std::nullopt;
  Resource resource;
  resource.status = *status;
  resource.body = std::move((*values)[1].data);
  for (AbiValue& header : (*values)[2].items) {
    resource.headers.emplace_back(std::move(header.items[0].data),
                                  std::move(header.items[1].data));
  }
  return resource;
}

std::variant<AutoCall, std::string> ParseAutoCall(std::string_view path,
                                                  std::string_view query) {
  AutoCall call;
  if (!query.empty()) {
    for (std::string_view pair : Split(query, '&')) {
      const size_t equals = pair.find('=');
      std::string_view key = pair.substr(0, equals);
      if (key != "returns" && key != "returnTypes") continue;
      const std::string value = PercentDecode(
          equals == std::string_view::npos ? "" : pair.substr(equals + 1), true);
      if (value.empty()) {
        call.returns = AutoCall::Returns::kBytes;
      } else if (value == "()") {
        call.returns = AutoCall::Returns::kRaw;
      } else {
        std::optional<AbiType> types = ParseAbiType(value);
        if (!types) return "Not valid return types: " + value;
        call.returns = AutoCall::Returns::kTypes;
        call.return_types = std::move(*types);
      }
    }
  }
  std::vector<std::string_view> segments = PathSegments(path);
  if (segments.empty()) return call;
  const std::string method = PercentDecode(segments[0], false);
  if (!IsMethodName(method)) return "Not a method name: " + method;
  AbiType arguments;
  arguments.kind = AbiType::Kind::kTuple;
  std::vector<AbiValue> values;
  for (size_t i = 1; i < segments.size(); ++i) {
    const std::string raw = PercentDecode(segments[i], false);
    std::variant<Argument, std::string> argument = ParseArgument(raw);
    if (std::string* error = std::get_if<std::string>(&argument)) return *error;
    Argument& parsed = std::get<Argument>(argument);
    call.extension = parsed.type.kind == AbiType::Kind::kString
                         ? FileExtension(parsed.value.data)
                         : "";
    arguments.items.push_back(std::move(parsed.type));
    values.push_back(std::move(parsed.value));
  }
  std::string signature = Signature(arguments);
  call.calldata = Selector(method + signature) + AbiEncode(arguments, values);
  return call;
}

std::optional<AutoBody> AutoCallBody(const AutoCall& call,
                                     std::string_view returned) {
  switch (call.returns) {
    case AutoCall::Returns::kBytes: {
      std::optional<std::vector<AbiValue>> values = AbiDecode(BytesType(), returned);
      if (!values) return std::nullopt;
      return AutoBody{std::move((*values)[0].data), false};
    }
    case AutoCall::Returns::kRaw: {
      std::optional<std::string> json =
          AbiJson(BytesType(), {AbiBytes(Bytes(returned))});
      return AutoBody{std::move(*json), true};
    }
    case AutoCall::Returns::kTypes: {
      std::optional<std::vector<AbiValue>> values =
          AbiDecode(call.return_types, returned);
      if (!values) return std::nullopt;
      std::optional<std::string> json = AbiJson(call.return_types, *values);
      if (!json) return std::nullopt;
      return AutoBody{std::move(*json), true};
    }
  }
  return std::nullopt;
}

}
