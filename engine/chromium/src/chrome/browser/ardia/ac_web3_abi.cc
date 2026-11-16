// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_web3_codec.h"


namespace ardia::web3 {
namespace {

constexpr size_t kWord = 32;
constexpr int kMaxTypeDepth = 8;
constexpr size_t kMaxDecoded = 64u << 20;
constexpr size_t kMaxJson = 16u << 20;

int HexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}


bool HasHexPrefix(std::string_view text) {
  return text.size() >= 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X');
}

Bytes WordOfSize(size_t value) {
  Bytes word(kWord, '\0');
  for (size_t i = 0; i < sizeof(size_t); ++i) {
    word[kWord - 1 - i] = static_cast<char>((value >> (8 * i)) & 0xff);
  }
  return word;
}

std::optional<size_t> SizeOfWord(std::string_view word, size_t limit) {
  size_t value = 0;
  for (size_t i = 0; i < kWord; ++i) {
    const unsigned char byte = static_cast<unsigned char>(word[i]);
    if (i < kWord - 4) {
      if (byte) return std::nullopt;
      continue;
    }
    value = (value << 8) | byte;
  }
  if (value > limit) return std::nullopt;
  return value;
}

std::optional<std::string_view> WordAt(std::string_view data, size_t at) {
  if (at > data.size() || data.size() - at < kWord) return std::nullopt;
  return data.substr(at, kWord);
}

size_t Padded(size_t size) {
  return (size + kWord - 1) / kWord * kWord;
}

bool IsDynamic(const AbiType& type) {
  switch (type.kind) {
    case AbiType::Kind::kBytes:
    case AbiType::Kind::kString:
      return true;
    case AbiType::Kind::kArray:
      return !type.length || IsDynamic(type.items[0]);
    case AbiType::Kind::kTuple:
      for (const AbiType& item : type.items) {
        if (IsDynamic(item)) return true;
      }
      return false;
    default:
      return false;
  }
}

size_t HeadSize(const AbiType& type) {
  if (IsDynamic(type)) return kWord;
  if (type.kind == AbiType::Kind::kArray) {
    return *type.length * HeadSize(type.items[0]);
  }
  if (type.kind == AbiType::Kind::kTuple) {
    size_t size = 0;
    for (const AbiType& item : type.items) size += HeadSize(item);
    return size;
  }
  return kWord;
}

std::vector<AbiType> Repeated(const AbiType& item, size_t count) {
  return std::vector<AbiType>(count, item);
}

Bytes EncodeOne(const AbiType& type, const AbiValue& value);

Bytes EncodeSequence(const std::vector<AbiType>& types,
                     const std::vector<AbiValue>& values) {
  size_t head_size = 0;
  for (const AbiType& type : types) head_size += HeadSize(type);
  Bytes head;
  Bytes tail;
  for (size_t i = 0; i < types.size(); ++i) {
    if (IsDynamic(types[i])) {
      head += WordOfSize(head_size + tail.size());
      tail += EncodeOne(types[i], values[i]);
    } else {
      head += EncodeOne(types[i], values[i]);
    }
  }
  return head + tail;
}

Bytes EncodeOne(const AbiType& type, const AbiValue& value) {
  switch (type.kind) {
    case AbiType::Kind::kBytes:
    case AbiType::Kind::kString: {
      Bytes out = WordOfSize(value.data.size()) + value.data;
      out.resize(kWord + Padded(value.data.size()), '\0');
      return out;
    }
    case AbiType::Kind::kArray: {
      Bytes items =
          EncodeSequence(Repeated(type.items[0], value.items.size()), value.items);
      return type.length ? items : WordOfSize(value.items.size()) + items;
    }
    case AbiType::Kind::kTuple:
      return EncodeSequence(type.items, value.items);
    default:
      return value.data;
  }
}

struct Decoder {
  std::string_view data;
  size_t budget = kMaxDecoded;

  bool Spend(size_t size) {
    if (size > budget) return false;
    budget -= size;
    return true;
  }

  std::optional<std::vector<AbiValue>> Sequence(
      const std::vector<AbiType>& types,
      size_t base) {
    std::vector<AbiValue> values;
    size_t head = base;
    for (const AbiType& type : types) {
      std::optional<AbiValue> value;
      if (IsDynamic(type)) {
        std::optional<std::string_view> word = WordAt(data, head);
        if (!word) return std::nullopt;
        std::optional<size_t> offset = SizeOfWord(*word, data.size() - base);
        if (!offset) return std::nullopt;
        value = Content(type, base + *offset);
      } else {
        value = Content(type, head);
      }
      if (!value) return std::nullopt;
      values.push_back(std::move(*value));
      head += HeadSize(type);
    }
    return values;
  }

  std::optional<AbiValue> Content(const AbiType& type, size_t at) {
    switch (type.kind) {
      case AbiType::Kind::kBytes:
      case AbiType::Kind::kString: {
        std::optional<std::string_view> word = WordAt(data, at);
        if (!word) return std::nullopt;
        std::optional<size_t> size = SizeOfWord(*word, data.size() - at - kWord);
        if (!size || !Spend(*size)) return std::nullopt;
        return AbiBytes(Bytes(data.substr(at + kWord, *size)));
      }
      case AbiType::Kind::kArray: {
        size_t count;
        size_t start = at;
        if (type.length) {
          count = *type.length;
        } else {
          std::optional<std::string_view> word = WordAt(data, at);
          if (!word) return std::nullopt;
          start = at + kWord;
          std::optional<size_t> size =
              SizeOfWord(*word, (data.size() - start) / kWord);
          if (!size) return std::nullopt;
          count = *size;
        }
        if (!Spend(count * kWord)) return std::nullopt;
        std::optional<std::vector<AbiValue>> items =
            Sequence(Repeated(type.items[0], count), start);
        if (!items) return std::nullopt;
        return AbiList(std::move(*items));
      }
      case AbiType::Kind::kTuple: {
        std::optional<std::vector<AbiValue>> items = Sequence(type.items, at);
        if (!items) return std::nullopt;
        return AbiList(std::move(*items));
      }
      default: {
        std::optional<std::string_view> word = WordAt(data, at);
        if (!word || !Spend(kWord)) return std::nullopt;
        return AbiWord(Bytes(*word));
      }
    }
  }
};

void AppendCompactHex(std::string& out, std::string_view word) {
  std::string hex = ToHex(word).substr(2);
  const size_t first = hex.find_first_not_of('0');
  out += "0x";
  out += first == std::string::npos ? "0" : hex.substr(first);
}


void AppendJsonString(std::string& out, std::string_view text) {
  static constexpr char kHex[] = "0123456789abcdef";
  out += '"';
  for (char c : text) {
    const unsigned char byte = static_cast<unsigned char>(c);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (byte < 0x20) {
          out += "\\u00";
          out += kHex[byte >> 4];
          out += kHex[byte & 0xf];
        } else {
          out += c;
        }
    }
  }
  out += '"';
}

bool AppendJson(std::string& out, const AbiType& type, const AbiValue& value) {
  if (out.size() > kMaxJson) return false;
  switch (type.kind) {
    case AbiType::Kind::kUint:
      out += '"';
      AppendCompactHex(out, value.data);
      out += '"';
      return true;
    case AbiType::Kind::kInt:
      out += '"';
      if (static_cast<unsigned char>(value.data[0]) & 0x80) {
        out += '-';
        AppendCompactHex(out, Negate(value.data));
      } else {
        AppendCompactHex(out, value.data);
      }
      out += '"';
      return true;
    case AbiType::Kind::kAddress:
      AppendJsonString(out, ToHex(std::string_view(value.data).substr(12)));
      return true;
    case AbiType::Kind::kBool:
      out += value.data.find_first_not_of('\0') == Bytes::npos ? "false" : "true";
      return true;
    case AbiType::Kind::kFixedBytes:
      AppendJsonString(out, ToHex(std::string_view(value.data).substr(0, type.size)));
      return true;
    case AbiType::Kind::kBytes:
      AppendJsonString(out, ToHex(value.data));
      return true;
    case AbiType::Kind::kString:
      AppendJsonString(out, value.data);
      return true;
    case AbiType::Kind::kArray:
    case AbiType::Kind::kTuple: {
      out += '[';
      for (size_t i = 0; i < value.items.size(); ++i) {
        if (i) out += ',';
        const AbiType& item =
            type.kind == AbiType::Kind::kArray ? type.items[0] : type.items[i];
        if (!AppendJson(out, item, value.items[i])) return false;
      }
      out += ']';
      return out.size() <= kMaxJson;
    }
  }
  return false;
}

std::optional<int> BitSize(std::string_view digits, int fallback) {
  if (digits.empty()) return fallback;
  if (!IsDecimal(digits) || digits.size() > 3 || digits[0] == '0') {
    return std::nullopt;
  }
  const int size = std::stoi(std::string(digits));
  if (size < 8 || size > 256 || size % 8) return std::nullopt;
  return size;
}

std::optional<AbiType> BaseType(std::string_view name) {
  AbiType type;
  auto sized = [&](std::string_view prefix, AbiType::Kind kind) -> bool {
    if (name.substr(0, prefix.size()) != prefix) return false;
    std::optional<int> size = BitSize(name.substr(prefix.size()), 256);
    if (!size) return false;
    type.kind = kind;
    type.size = *size;
    return true;
  };
  if (name == "bool") {
    type.kind = AbiType::Kind::kBool;
  } else if (name == "address") {
    type.kind = AbiType::Kind::kAddress;
  } else if (name == "string") {
    type.kind = AbiType::Kind::kString;
  } else if (name == "bytes") {
    type.kind = AbiType::Kind::kBytes;
  } else if (name.substr(0, 5) == "bytes") {
    std::string_view digits = name.substr(5);
    if (!IsDecimal(digits) || digits.size() > 2 || digits[0] == '0') {
      return std::nullopt;
    }
    const int size = std::stoi(std::string(digits));
    if (size > 32) return std::nullopt;
    type.kind = AbiType::Kind::kFixedBytes;
    type.size = size;
  } else if (!sized("uint", AbiType::Kind::kUint) &&
             !sized("int", AbiType::Kind::kInt)) {
    return std::nullopt;
  }
  return type;
}

struct TypeParser {
  std::string_view text;
  size_t at = 0;

  std::optional<AbiType> Tuple(int depth) {
    if (depth > kMaxTypeDepth || at >= text.size() || text[at] != '(') {
      return std::nullopt;
    }
    ++at;
    AbiType tuple;
    tuple.kind = AbiType::Kind::kTuple;
    if (at < text.size() && text[at] == ')') {
      ++at;
      return tuple;
    }
    while (true) {
      std::optional<AbiType> item = Item(depth + 1);
      if (!item) return std::nullopt;
      tuple.items.push_back(std::move(*item));
      if (at >= text.size()) return std::nullopt;
      if (text[at] == ')') {
        ++at;
        return tuple;
      }
      if (text[at++] != ',') return std::nullopt;
    }
  }

  std::optional<AbiType> Item(int depth) {
    std::optional<AbiType> type;
    if (at < text.size() && text[at] == '(') {
      type = Tuple(depth);
      if (type && type->items.empty()) return std::nullopt;
    } else {
      const size_t start = at;
      while (at < text.size() && text[at] != ',' && text[at] != ')' &&
             text[at] != '[') {
        ++at;
      }
      type = BaseType(text.substr(start, at - start));
    }
    while (type && at < text.size() && text[at] == '[') {
      if (++depth > kMaxTypeDepth) return std::nullopt;
      const size_t close = text.find(']', at);
      if (close == std::string_view::npos) return std::nullopt;
      std::string_view length = text.substr(at + 1, close - at - 1);
      AbiType array;
      array.kind = AbiType::Kind::kArray;
      if (!length.empty()) {
        if (!IsDecimal(length) || length[0] == '0' || length.size() > 4) {
          return std::nullopt;
        }
        array.length = static_cast<size_t>(std::stoi(std::string(length)));
      }
      array.items.push_back(std::move(*type));
      type = std::move(array);
      at = close + 1;
    }
    return type;
  }
};

}

std::string ToHex(std::string_view bytes) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "0x";
  out.reserve(2 + bytes.size() * 2);
  for (char c : bytes) {
    const unsigned char byte = static_cast<unsigned char>(c);
    out += kHex[byte >> 4];
    out += kHex[byte & 0xf];
  }
  return out;
}

std::optional<Bytes> FromHex(std::string_view hex) {
  if (!HasHexPrefix(hex) || hex.size() % 2) return std::nullopt;
  Bytes out;
  out.reserve(hex.size() / 2 - 1);
  for (size_t i = 2; i < hex.size(); i += 2) {
    const int high = HexDigit(hex[i]);
    const int low = HexDigit(hex[i + 1]);
    if (high < 0 || low < 0) return std::nullopt;
    out += static_cast<char>(high * 16 + low);
  }
  return out;
}

std::optional<Bytes> ParseAddress(std::string_view text) {
  if (text.size() != 42) return std::nullopt;
  return FromHex(text);
}

Bytes Selector(std::string_view signature) {
  return Keccak256(signature).substr(0, 4);
}

std::string PercentDecode(std::string_view text, bool plus_is_space) {
  std::string out;
  out.reserve(text.size());
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '%' && i + 2 < text.size() && HexDigit(text[i + 1]) >= 0 &&
        HexDigit(text[i + 2]) >= 0) {
      out += static_cast<char>(HexDigit(text[i + 1]) * 16 + HexDigit(text[i + 2]));
      i += 2;
    } else if (plus_is_space && text[i] == '+') {
      out += ' ';
    } else {
      out += text[i];
    }
  }
  return out;
}

AbiValue AbiWord(Bytes word) {
  return AbiValue{AbiValue::Kind::kWord, std::move(word), {}};
}

AbiValue AbiBytes(Bytes bytes) {
  return AbiValue{AbiValue::Kind::kBytes, std::move(bytes), {}};
}

AbiValue AbiList(std::vector<AbiValue> items) {
  return AbiValue{AbiValue::Kind::kList, {}, std::move(items)};
}

std::optional<AbiType> ParseAbiType(std::string_view text) {
  TypeParser parser{text};
  std::optional<AbiType> type = parser.Tuple(0);
  if (!type || parser.at != text.size()) return std::nullopt;
  return type;
}

std::string Signature(const AbiType& type) {
  switch (type.kind) {
    case AbiType::Kind::kUint: return "uint" + std::to_string(type.size);
    case AbiType::Kind::kInt: return "int" + std::to_string(type.size);
    case AbiType::Kind::kAddress: return "address";
    case AbiType::Kind::kBool: return "bool";
    case AbiType::Kind::kFixedBytes: return "bytes" + std::to_string(type.size);
    case AbiType::Kind::kBytes: return "bytes";
    case AbiType::Kind::kString: return "string";
    case AbiType::Kind::kArray:
      return Signature(type.items[0]) + "[" +
             (type.length ? std::to_string(*type.length) : "") + "]";
    case AbiType::Kind::kTuple: {
      std::string out = "(";
      for (size_t i = 0; i < type.items.size(); ++i) {
        if (i) out += ',';
        out += Signature(type.items[i]);
      }
      return out + ")";
    }
  }
  return "";
}

Bytes AbiEncode(const AbiType& tuple, const std::vector<AbiValue>& values) {
  return EncodeSequence(tuple.items, values);
}

std::optional<std::vector<AbiValue>> AbiDecode(const AbiType& tuple,
                                               std::string_view data) {
  Decoder decoder{data};
  return decoder.Sequence(tuple.items, 0);
}

std::optional<std::string> AbiJson(const AbiType& tuple,
                                   const std::vector<AbiValue>& values) {
  std::string out;
  if (!AppendJson(out, tuple, AbiList(values))) return std::nullopt;
  return out;
}

bool IsDecimal(std::string_view text) {
  if (text.empty()) return false;
  for (char c : text) {
    if (c < '0' || c > '9') return false;
  }
  return true;
}

Bytes Negate(std::string_view word) {
  Bytes out(word);
  for (char& c : out) c = static_cast<char>(~c);
  for (size_t i = kWord; i-- > 0;) {
    out[i] = static_cast<char>(static_cast<unsigned char>(out[i]) + 1);
    if (out[i] != '\0') break;
  }
  return out;
}

}
