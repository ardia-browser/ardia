#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <variant>

#include "chrome/browser/ardia/ac_web3_codec.h"

using namespace ardia::web3;

namespace {

int g_failures = 0;

void Expect(bool condition, const char* what) {
  if (!condition) {
    std::printf("FAIL: %s\n", what);
    ++g_failures;
  }
}

std::string Hex(std::string_view bytes) {
  return ToHex(bytes);
}

Bytes Unhex(std::string_view hex) {
  return *FromHex(hex);
}

std::string Words(std::initializer_list<const char*> words) {
  std::string hex = "0x";
  for (const char* word : words) hex += std::string(64 - std::string(word).size(), '0') + word;
  return hex;
}

std::string Ascii(std::string_view text) {
  std::string hex = Hex(text).substr(2);
  hex.resize((hex.size() + 63) / 64 * 64, '0');
  return hex;
}

AutoCall Auto(std::string_view path, std::string_view query = "") {
  std::variant<AutoCall, std::string> call = ParseAutoCall(path, query);
  if (std::string* error = std::get_if<std::string>(&call)) {
    std::printf("unexpected error for %.*s: %s\n", static_cast<int>(path.size()), path.data(),
                error->c_str());
    ++g_failures;
    return {};
  }
  return std::get<AutoCall>(call);
}

bool Refused(std::string_view path) {
  return std::holds_alternative<std::string>(ParseAutoCall(path, ""));
}

void KeccakMatchesEthereum() {
  Expect(Hex(Keccak256("")) == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak of nothing");
  Expect(Hex(Keccak256("abc")) == "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak of abc");
  Expect(Hex(Keccak256(std::string(135, 'a'))) == "0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446", "keccak one byte short of a block");
  Expect(Hex(Keccak256(std::string(136, 'a'))) == "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e", "keccak of one full block");
  Expect(Hex(Keccak256(std::string(300, 'a'))) == "0x5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826", "keccak over three blocks");
  Expect(Hex(Selector("resolveMode()")) == "0xdd473fae", "resolveMode selector from ERC-6860");
  Expect(Hex(Selector("balanceOf(address)")) == "0x70a08231", "balanceOf selector");
}

void NameHashMatchesErc137() {
  Expect(NameHash("") == Bytes(32, '\0'), "empty name hashes to zero");
  Expect(Hex(NameHash("eth")) == "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae", "namehash eth");
  Expect(Hex(NameHash("foo.eth")) == "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f", "namehash foo.eth");
}

void HostsAndRecords() {
  std::optional<Host> address = ParseHost("0xe8389e061c8ae56fa7e17b8fe9f80a8c8e31b450");
  Expect(address && address->address && Hex(*address->address) == "0xe8389e061c8ae56fa7e17b8fe9f80a8c8e31b450", "address host");
  std::optional<Host> name = ParseHost("ocweb.eth");
  Expect(name && !name->address && name->name == "ocweb.eth", "ENS host");
  Expect(!ParseHost("example.com"), "a name outside .eth");
  Expect(!ParseHost("0x1234"), "a short address");
  Expect(!ParseHost("a..eth"), "an empty label");

  std::optional<ContentContract> optimism = ParseContentContract("oeth:0x2b7C11e49FB41580787C599A29721c3D5Daf65Db");
  Expect(optimism && optimism->chain_id == 10u && Hex(optimism->address) == "0x2b7c11e49fb41580787c599a29721c3d5daf65db", "ERC-3770 record moves the chain");
  std::optional<ContentContract> bnb = ParseContentContract("bnb:0x2b7C11e49FB41580787C599A29721c3D5Daf65Db");
  std::optional<ContentContract> scroll = ParseContentContract("SCR:0x2b7C11e49FB41580787C599A29721c3D5Daf65Db");
  Expect(bnb && bnb->chain_id == 56u && scroll && scroll->chain_id == 534352u, "registered ERC-3770 short names beyond the first few, in any case");
  std::optional<ContentContract> bare = ParseContentContract(" 0xe8389E061c8AE56fa7e17B8fe9f80A8c8e31B450 ");
  Expect(bare && !bare->chain_id, "a bare address keeps the URL's chain");
  Expect(!ParseContentContract("w3q-g:0xEbcA4860ebBe969E9Bc42643fcb437879dBDa9C6"), "an unknown chain short name");
  Expect(!ParseContentContract("eth:not-an-address"), "a record that isn't an address");
}

void ResolveModes() {
  const Bytes resource = Unhex(Words({"3532313900000000000000000000000000000000000000000000000000000000"}));
  Expect(ModeFromResolveMode(resource) == Mode::kResource, "5219 mode");
  Expect(ModeFromResolveMode(Bytes(32, '\0')) == Mode::kAuto, "zero means auto");
  Expect(ModeFromResolveMode(Bytes()) == Mode::kAuto, "an empty answer means auto");
  Expect(ModeFromResolveMode(std::nullopt) == Mode::kAuto, "a revert means auto");
  Expect(ModeFromResolveMode(Unhex(Words({"6d616e75616c0000000000000000000000000000000000000000000000000000"}))) == Mode::kManual, "manual mode");
  Expect(ModeFromResolveMode(Unhex(Words({"4155544f00000000000000000000000000000000000000000000000000000000"}))) == Mode::kAuto, "mode names ignore case");
  Expect(ModeFromResolveMode(Unhex("0x3532313900ff" + std::string(52, '0'))) == Mode::kUnsupported, "bytes after the name");
  Expect(ModeFromResolveMode(Unhex("0x35323139")) == Mode::kUnsupported, "a short answer");
}

void ResourceRequests() {
  Expect(Hex(*ResourceRequestCall("/", "")) == "0x1374c460" + Words({"40", "60", "0", "0"}).substr(2), "the root asks for no segments and no params");
  const Bytes call = *ResourceRequestCall("/a%20b/c+d/", "x=1&y=a+b%26&flag");
  static const AbiType type = *ParseAbiType("(string[],(string,string)[])");
  std::optional<std::vector<AbiValue>> decoded = AbiDecode(type, std::string_view(call).substr(4));
  Expect(decoded.has_value(), "a resource request decodes");
  if (!decoded) return;
  const auto& segments = (*decoded)[0].items;
  Expect(segments.size() == 2 && segments[0].data == "a b" && segments[1].data == "c+d", "path segments are percent-decoded, a trailing slash adds none");
  const auto& params = (*decoded)[1].items;
  Expect(params.size() == 3 && params[1].items[0].data == "y" && params[1].items[1].data == "a b&" && params[2].items[0].data == "flag" && params[2].items[1].data.empty(),
         "query pairs decode like a form");
  std::string pairs = "a";
  for (int i = 1; i < 256; ++i) pairs += "&a";
  std::string segments_path;
  for (int i = 0; i < 256; ++i) segments_path += "/s";
  Expect(ResourceRequestCall(segments_path, pairs).has_value(), "256 path segments and 256 query pairs are encoded");
  Expect(!ResourceRequestCall(segments_path + "/s", "") && !ResourceRequestCall("/", pairs + "&a"), "a 257th segment or pair is refused before anything is built");
  Expect(std::holds_alternative<std::string>(ParseAutoCall(segments_path + "/s", "")), "auto mode refuses as many segments");
}

void ResourceResponses() {
  const Bytes answer = Unhex(Words({"c8", "60", "a0", "2"}) + Ascii("hi") +
                             Words({"1", "20", "40", "80", "c"}).substr(2) + Ascii("Content-Type") +
                             Words({"a"}).substr(2) + Ascii("text/plain"));
  std::optional<Resource> resource = DecodeResource(answer);
  Expect(resource && resource->status == 200 && resource->body == "hi" && resource->headers.size() == 1 &&
             resource->headers[0].first == "Content-Type" && resource->headers[0].second == "text/plain",
         "an ERC-5219 answer decodes");
  Bytes bad_status = answer;
  bad_status[31] = 0x05;
  Expect(!DecodeResource(bad_status), "a status below 100");
  Expect(!DecodeResource(answer.substr(0, 100)), "a cut answer");
  Expect(!DecodeResource(Unhex(Words({"c8", "ffffff", "a0"}))), "an offset past the end");
  Expect(!DecodeResource(Unhex(Words({"c8", "60", "a0", "ffffffff"}))), "a body longer than the answer");
}

void AutoCalls() {
  Expect(Auto("/").calldata.empty(), "the root calls with no data");
  Expect(Hex(Auto("/balanceOf/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045").calldata) ==
             "0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
         "a 20-byte argument is an address");
  Expect(Hex(Auto("/x/int8!-128").calldata).substr(10) == std::string(62, 'f') + "80", "the smallest int8");
  Expect(Refused("/x/int8!-129"), "below int8");
  Expect(Refused("/x/uint8!256"), "above uint8");
  Expect(Refused("/x/bytes2!0x010203"), "bytes2 with three bytes");
  Expect(Refused("/x/vitalik.eth"), "names as arguments");
  Expect(Refused("/1x"), "a method can't start with a digit");
  Expect(Auto("/page/string!index.html").extension == "html", "a string's extension gives the type");
  Expect(Auto("/page/string!index.html/1").extension.empty(), "only the last argument's extension counts");

  AutoCall supply = Auto("/totalSupply", "returns=(uint256)");
  std::optional<AutoBody> json = AutoCallBody(supply, Unhex(Words({"9184e72a000"})));
  Expect(json && json->json && json->body == "[\"0x9184e72a000\"]", "ERC-6860 example 5");
  AutoCall raw = Auto("/totalSupply", "returns=()");
  std::optional<AutoBody> raw_body = AutoCallBody(raw, Unhex("0x0102"));
  Expect(raw_body && raw_body->body == "[\"0x0102\"]", "returns=() gives the raw answer");
  std::optional<AutoBody> html = AutoCallBody(Auto("/tokenHTML/1"), Unhex(Words({"20", "3"}) + Ascii("<p>")));
  Expect(html && !html->json && html->body == "<p>", "the default answer is ABI bytes");

  AutoCall typed = Auto("/x", "returns=(address,bool,int256,string,uint8[2])");
  std::optional<AutoBody> values = AutoCallBody(
      typed, Unhex(Words({"d8da6bf26964af9d7eed9e03e53415d37aa96045", "1",
                          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "c0", "0", "7", "2"}) +
                   Ascii("a\"")));
  Expect(values && values->body == "[\"0xd8da6bf26964af9d7eed9e03e53415d37aa96045\",true,\"-0x1\",\"a\\\"\",[\"0x0\",\"0x7\"]]",
         "typed answers become JSON");
  Expect(std::holds_alternative<std::string>(ParseAutoCall("/x", "returns=(uint7)")), "a bad return type");
  std::string deep = "returns=(uint256";
  for (int i = 0; i < 100000; ++i) deep += "[1]";
  Expect(std::holds_alternative<std::string>(ParseAutoCall("/x", deep + ")")), "array nesting counts toward the depth limit");
  Expect(!ParseAbiType("((uint256[1][1][1][1][1][1])[1][1][1][1][1][1][])"), "tuple and array nesting add up to one depth limit");
  Expect(ParseAbiType("((uint256[1][1][1])[1][1][1][1])").has_value(), "eight containers under the root tuple are allowed");
  Expect(!ParseAbiType("((uint256[1][1][1])[1][1][1][1][1])"), "a ninth is not");
  Expect(std::holds_alternative<AutoCall>(ParseAutoCall("/x", "returns=(uint256[2][][3])")), "a few array dimensions are fine");
}

}

void ContractPoliciesLoseReporting() {
  Expect(WithoutCspReporting("default-src 'self'; report-uri https://t.example/r") == "default-src 'self'", "report-uri dropped, the rest kept");
  Expect(WithoutCspReporting("Report-To x;img-src *, script-src 'none'; REPORT-URI https://t.example") == "img-src *, script-src 'none'", "reporting dropped in each policy of a list, any case");
  Expect(WithoutCspReporting(" report-uri https://t.example ") == "", "a reporting-only policy leaves nothing");
  Expect(WithoutCspReporting("default-src 'none'; report-uri\fhttps://t.example/r") == "default-src 'none'", "a form feed separates the directive name, as in Chromium's CSP parser");
  Expect(WithoutCspReporting("\f\r\nreport-to x; img-src *") == "img-src *", "leading form feed, CR and LF are trimmed");
  Expect(WithoutCspReporting("default-src 'none'; style-src 'unsafe-inline'") == "default-src 'none'; style-src 'unsafe-inline'", "a policy without reporting is unchanged");
}

void HugeStaticTypesFailFast() {
  std::string tuple = "(uint256";
  for (int i = 1; i < 2000; ++i) tuple += ",uint256";
  tuple += ")";
  const AutoCall huge = Auto("/x", "returns=(" + tuple + "[9999])");
  const auto start = std::chrono::steady_clock::now();
  Expect(!AutoCallBody(huge, Unhex(Words({"1"}))), "a huge static array fails on a short answer");
  Expect(std::chrono::steady_clock::now() - start < std::chrono::milliseconds(300), "it fails before 9999 copies of a 2000-member tuple are made");
  Expect(!AutoCallBody(Auto("/x", "returns=(uint256[9999][9999][9999][9999][9999][9999])"), Unhex(Words({"1"}))), "fixed lengths whose size overflows fail");
}

Bytes Word(uint64_t n) {
  Bytes word(32, '\0');
  for (int i = 0; i < 8; ++i) word[31 - i] = static_cast<char>(n >> (8 * i));
  return word;
}

void AliasedDynamicElementsFailFast() {
  std::string tuple = "(string";
  for (int i = 1; i < 2000; ++i) tuple += ",string";
  tuple += ")";
  const AutoCall call = Auto("/x", "returns=(" + tuple + "[9999])");
  Bytes answer = Word(32);
  for (int i = 0; i < 9999; ++i) answer += Word(9999 * 32);
  for (int i = 0; i < 2000; ++i) answer += Word(2000 * 32);
  answer += Word(0);
  const auto start = std::chrono::steady_clock::now();
  Expect(!AutoCallBody(call, answer), "9999 aliased copies of a 2000-string tuple exceed the value cap");
  Expect(std::chrono::steady_clock::now() - start < std::chrono::seconds(10), "they fail before 20 million types and values are made");
}

void ValueCapFitsNestedAnswers() {
  const AutoCall nested = Auto("/x", "returns=(uint256[1][1][1][])");
  Bytes answer = Word(32) + Word(65536);
  for (int i = 0; i < 65536; ++i) answer += Word(i);
  Expect(AutoCallBody(nested, answer).has_value(), "65,536 words in three single-element arrays decode, a valid 2 MB answer");
  const AutoCall deepest = Auto("/x", "returns=((uint256[1][1][1])[1][1][1][])");
  Bytes full = Word(32) + Word(78000);
  for (int i = 0; i < 78000; ++i) full += Word(i);
  Expect(AutoCallBody(deepest, full).has_value(), "a full RPC reply of the deepest allowed type fits the value cap");

  std::string tuple = "(uint256";
  for (int i = 1; i < 20000; ++i) tuple += ",uint256";
  tuple += ")";
  const AutoCall empties = Auto("/x", "returns=(" + tuple + "[][])");
  Bytes aliased = Word(32) + Word(9999);
  for (int i = 0; i < 9999; ++i) aliased += Word(9999 * 32);
  aliased += Word(0);
  const auto start = std::chrono::steady_clock::now();
  Expect(AutoCallBody(empties, aliased).has_value(), "9999 aliased empty arrays of a wide tuple decode");
  Expect(std::chrono::steady_clock::now() - start < std::chrono::seconds(3), "an empty array doesn't measure its element type");
}

int main() {
  KeccakMatchesEthereum();
  NameHashMatchesErc137();
  HostsAndRecords();
  ResolveModes();
  ResourceRequests();
  ResourceResponses();
  AutoCalls();
  ContractPoliciesLoseReporting();
  HugeStaticTypesFailFast();
  AliasedDynamicElementsFailFast();
  ValueCapFitsNestedAnswers();
  if (g_failures) {
    std::printf("%d web3 codec scenarios failed\n", g_failures);
    return 1;
  }
  std::printf("web3 codec scenarios passed\n");
  return 0;
}
