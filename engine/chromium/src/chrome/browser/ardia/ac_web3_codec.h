// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_WEB3_CODEC_H_
#define CHROME_BROWSER_ARDIA_AC_WEB3_CODEC_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace ardia::web3 {

using Bytes = std::string;

Bytes Keccak256(std::string_view data);
std::string ToHex(std::string_view bytes);
std::optional<Bytes> FromHex(std::string_view hex);
std::optional<Bytes> ParseAddress(std::string_view text);
Bytes NameHash(std::string_view name);
Bytes Selector(std::string_view signature);
std::string PercentDecode(std::string_view text, bool plus_is_space);
bool IsDecimal(std::string_view text);
Bytes Negate(std::string_view word);

struct AbiValue {
  enum class Kind { kWord, kBytes, kList };
  Kind kind = Kind::kWord;
  Bytes data;
  std::vector<AbiValue> items;
};

AbiValue AbiWord(Bytes word);
AbiValue AbiBytes(Bytes bytes);
AbiValue AbiList(std::vector<AbiValue> items);

struct AbiType {
  enum class Kind { kUint, kInt, kAddress, kBool, kFixedBytes, kBytes, kString, kArray, kTuple };
  Kind kind = Kind::kUint;
  int size = 256;
  std::optional<size_t> length;
  std::vector<AbiType> items;
};

std::optional<AbiType> ParseAbiType(std::string_view text);
std::string Signature(const AbiType& type);
Bytes AbiEncode(const AbiType& tuple, const std::vector<AbiValue>& values);
std::optional<std::vector<AbiValue>> AbiDecode(const AbiType& tuple, std::string_view data);
std::optional<std::string> AbiJson(const AbiType& tuple, const std::vector<AbiValue>& values);

enum class Mode { kAuto, kResource, kManual, kUnsupported };
Mode ModeFromResolveMode(std::optional<std::string_view> returned);

struct Host {
  std::optional<Bytes> address;
  std::string name;
};
std::optional<Host> ParseHost(std::string_view host);

struct ContentContract {
  Bytes address;
  std::optional<uint64_t> chain_id;
};
std::optional<ContentContract> ParseContentContract(std::string_view record);

std::optional<Bytes> ResourceRequestCall(std::string_view path, std::string_view query);

struct Resource {
  int status = 0;
  Bytes body;
  std::vector<std::pair<std::string, std::string>> headers;
};
std::optional<Resource> DecodeResource(std::string_view returned);
std::string WithoutCspReporting(std::string_view header);

struct AutoCall {
  Bytes calldata;
  enum class Returns { kBytes, kRaw, kTypes };
  Returns returns = Returns::kBytes;
  AbiType return_types;
  std::string extension;
};
std::variant<AutoCall, std::string> ParseAutoCall(std::string_view path, std::string_view query);

struct AutoBody {
  Bytes body;
  bool json = false;
};
std::optional<AutoBody> AutoCallBody(const AutoCall& call, std::string_view returned);

}

#endif
