#include <stddef.h>
#include <stdint.h>

#include <algorithm>
#include <array>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/base64.h"
#include "base/command_line.h"
#include "base/compiler_specific.h"
#include "base/containers/span.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"

#include "ardia/core_rs/include/ardia_core.h"


namespace {

constexpr char kRepoSwitch[] = "ardia-repo";
constexpr std::array<std::string_view, 5> kVaultPayloads = {"log-line", "pattern-1019", "pattern-1020", "pattern-1021", "empty"};

class Buf {
 public:
  Buf() = default;
  Buf(const Buf&) = delete;
  Buf& operator=(const Buf&) = delete;
  ~Buf() { ardia_buf_free(&buf_); }

  ardia_buf* out() { return &buf_; }

  std::string str() const {
    if (!buf_.ptr) {
      return std::string();
    }
    base::span<const uint8_t> bytes = UNSAFE_BUFFERS(base::span<const uint8_t>(buf_.ptr, buf_.len));
    return std::string(bytes.begin(), bytes.end());
  }

 private:
  ardia_buf buf_ = {nullptr, 0};
};

struct Reply {
  ardia_status status;
  std::string data;
};

const uint8_t* Ptr(std::string_view text) {
  return reinterpret_cast<const uint8_t*>(text.data());
}

struct KeysDeleter {
  void operator()(ardia_sync_keys* keys) const { ardia_sync_keys_free(keys); }
};

class Keys {
 public:
  explicit Keys(std::string_view entropy) {
    ardia_sync_keys* keys = nullptr;
    status_ = ardia_sync_keys_new(Ptr(entropy), entropy.size(), &keys);
    keys_.reset(keys);
  }

  bool ok() const { return status_ == ARDIA_STATUS_OK && keys_; }

  std::string ChainTag() const {
    Buf out;
    EXPECT_EQ(ardia_sync_chain_tag(keys_.get(), out.out()), ARDIA_STATUS_OK);
    return out.str();
  }

  std::string ScopeTag(std::string_view scope) const {
    Buf out;
    EXPECT_EQ(ardia_sync_scope_tag(keys_.get(), Ptr(scope), scope.size(), out.out()), ARDIA_STATUS_OK);
    return out.str();
  }

  Reply Seal(std::string_view payload, std::string_view scope_tag, std::string_view id) const {
    Buf out;
    ardia_status status = ardia_sync_seal(keys_.get(), Ptr(payload), payload.size(), Ptr(scope_tag), scope_tag.size(),
                                          Ptr(id), id.size(), out.out());
    return {status, out.str()};
  }

  Reply Open(std::string_view file, std::string_view scope_tag, std::string_view id) const {
    Buf out;
    ardia_status status = ardia_sync_open(keys_.get(), Ptr(file), file.size(), Ptr(scope_tag), scope_tag.size(),
                                          Ptr(id), id.size(), out.out());
    return {status, out.str()};
  }

  Reply SealPassword(std::string_view password, std::string_view origin, std::string_view username) const {
    Buf out;
    ardia_status status = ardia_sync_seal_password(keys_.get(), Ptr(password), password.size(), Ptr(origin),
                                                   origin.size(), Ptr(username), username.size(), out.out());
    return {status, out.str()};
  }

  Reply OpenPassword(std::string_view sealed, std::string_view origin, std::string_view username) const {
    Buf out;
    ardia_status status = ardia_sync_open_password(keys_.get(), Ptr(sealed), sealed.size(), Ptr(origin),
                                                   origin.size(), Ptr(username), username.size(), out.out());
    return {status, out.str()};
  }

 private:
  ardia_status status_ = ARDIA_STATUS_INVALID_ARGUMENT;
  std::unique_ptr<ardia_sync_keys, KeysDeleter> keys_;
};

Reply PhraseFromEntropy(std::string_view entropy) {
  Buf out;
  ardia_status status = ardia_phrase_from_entropy(Ptr(entropy), entropy.size(), out.out());
  return {status, out.str()};
}

Reply PhraseToEntropy(std::string_view text) {
  Buf out;
  ardia_status status = ardia_phrase_to_entropy(Ptr(text), text.size(), out.out());
  return {status, out.str()};
}

Reply NewFileId() {
  Buf out;
  ardia_status status = ardia_sync_new_file_id(out.out());
  return {status, out.str()};
}

Reply VaultList(std::string_view request) {
  Buf out;
  ardia_status status = ardia_vault_list(Ptr(request), request.size(), out.out());
  return {status, out.str()};
}

base::FilePath Repo() {
  return base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(kRepoSwitch);
}

base::FilePath Fixtures() {
  return Repo().AppendASCII("packages/sync/tests/fixtures");
}

base::FilePath Vectors() {
  return Fixtures().AppendASCII("sync-vectors");
}

std::string ReadFile(const base::FilePath& path) {
  std::string data;
  EXPECT_TRUE(base::ReadFileToString(path, &data)) << path;
  return data;
}

base::Value Json(std::string_view text) {
  std::optional<base::Value> value = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  EXPECT_TRUE(value.has_value()) << text.substr(0, 200);
  return value ? std::move(*value) : base::Value();
}

base::Value JsonFile(const base::FilePath& path) {
  return Json(ReadFile(path));
}

std::string Str(const base::DictValue& dict, std::string_view key) {
  const std::string* value = dict.FindString(key);
  EXPECT_TRUE(value) << "missing string " << key;
  return value ? *value : std::string();
}

std::string Hex(std::string_view hex) {
  std::string bytes;
  EXPECT_TRUE(base::HexStringToString(hex, &bytes)) << hex;
  return bytes;
}

std::string ToHex(std::string_view bytes) {
  return base::HexEncodeLower(bytes);
}

std::string Base64(std::string_view text) {
  std::string bytes;
  EXPECT_TRUE(base::Base64Decode(text, &bytes)) << text;
  return bytes;
}

std::string ToBase64(std::string_view bytes) {
  return base::Base64Encode(bytes);
}

std::string FlipBit(std::string bytes, size_t index, uint8_t mask) {
  bytes[index] = static_cast<char>(static_cast<uint8_t>(bytes[index]) ^ mask);
  return bytes;
}

size_t Padded(size_t payload_size) {
  return (4 + payload_size + 1023) / 1024 * 1024;
}

std::string FileName(std::string_view id) {
  return std::string(id) + ".nns";
}

std::string VaultPath(const Keys& keys, std::string_view scope, std::string_view name) {
  return "vault/" + keys.ChainTag() + "/" + keys.ScopeTag(scope) + "/" + std::string(name);
}

std::map<std::string, std::string> Tree(const base::FilePath& root) {
  std::map<std::string, std::string> tree;
  base::FileEnumerator files(root, true, base::FileEnumerator::FILES);
  for (base::FilePath path = files.Next(); !path.empty(); path = files.Next()) {
    base::FilePath relative;
    EXPECT_TRUE(root.AppendRelativePath(path, &relative));
    tree[relative.AsUTF8Unsafe()] = ReadFile(path);
  }
  return tree;
}

std::vector<std::string> Names(const base::FilePath& folder) {
  std::vector<std::string> names;
  base::FileEnumerator entries(folder, false, base::FileEnumerator::FILES | base::FileEnumerator::DIRECTORIES);
  for (base::FilePath path = entries.Next(); !path.empty(); path = entries.Next()) {
    names.push_back(path.BaseName().AsUTF8Unsafe());
  }
  return names;
}

std::vector<std::string> Strings(const base::ListValue& list) {
  std::vector<std::string> out;
  for (const base::Value& item : list) {
    out.push_back(item.GetString());
  }
  return out;
}

std::vector<std::string> Sorted(std::vector<std::string> items) {
  std::sort(items.begin(), items.end());
  return items;
}

struct ScopeRead {
  std::vector<std::pair<std::string, std::string>> files;
  std::vector<std::string> damaged;
  std::vector<std::string> pending;
  std::vector<std::string> present;
};

ScopeRead ReadScope(const base::FilePath& vault, const Keys& keys, std::string_view scope) {
  const std::string scope_tag = keys.ScopeTag(scope);
  const base::FilePath folder = vault.AppendASCII(keys.ChainTag()).AppendASCII(scope_tag);
  base::ListValue names;
  for (const std::string& name : Names(folder)) {
    names.Append(name);
  }
  std::string request;
  base::DictValue body;
  body.Set("names", std::move(names));
  EXPECT_TRUE(base::JSONWriter::Write(body, &request));
  Reply reply = VaultList(request);
  EXPECT_EQ(reply.status, ARDIA_STATUS_OK) << reply.data;
  base::Value listing = Json(reply.data);
  const base::DictValue& dict = listing.GetDict();
  ScopeRead read;
  read.pending = Strings(*dict.FindList("pending"));
  read.present = Strings(*dict.FindList("present"));
  for (const std::string& id : Strings(*dict.FindList("open"))) {
    Reply opened = keys.Open(ReadFile(folder.AppendASCII(FileName(id))), scope_tag, id);
    if (opened.status == ARDIA_STATUS_OK) {
      read.files.emplace_back(id, opened.data);
    } else {
      read.damaged.push_back(id);
    }
  }
  return read;
}

class Inputs {
 public:
  Inputs() : value_(JsonFile(Vectors().AppendASCII("inputs.json"))) {}

  const base::DictValue& dict() const { return value_.GetDict(); }

  std::string Entropy(std::string_view name) const { return Hex(Str(*dict().FindDict("entropies"), name)); }

  Keys MakeKeys(std::string_view name) const { return Keys(Entropy(name)); }

  std::string Payload(std::string_view name) const { return Base64(Str(*dict().FindDict("payloads"), name)); }

  std::vector<std::string> EntropyNames() const {
    std::vector<std::string> names;
    for (const auto [name, value] : *dict().FindDict("entropies")) {
      names.push_back(name);
    }
    return Sorted(names);
  }

  std::vector<std::string> Scopes() const { return Strings(*dict().FindList("scopes")); }

  const base::ListValue& List(std::string_view key) const { return *dict().FindList(key); }

 private:
  base::Value value_;
};

base::Value Expected() {
  return JsonFile(Vectors().AppendASCII("expected.json"));
}

class ArdiaCoreRsVectorsTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_FALSE(Repo().empty()) << "pass --" << kRepoSwitch
                                 << "=\"$AC_REPO\", with AC_REPO set to the absolute path of an Ardia checkout";
    ASSERT_TRUE(base::PathExists(Vectors().AppendASCII("inputs.json")))
        << Vectors() << " is missing: --" << kRepoSwitch << " must name an Ardia checkout (set AC_REPO to its absolute path)";
  }
};

TEST_F(ArdiaCoreRsVectorsTest, TheAbiIsVersionOne) {
  EXPECT_EQ(ardia_abi_version(), static_cast<uint32_t>(ARDIA_ABI_VERSION));
  EXPECT_EQ(ARDIA_ABI_VERSION, 1);
}

TEST_F(ArdiaCoreRsVectorsTest, CommittedBytesCarryTheirInputsAndPasswordsSealExactly) {
  Inputs inputs;
  base::Value expected_value = Expected();
  const base::DictValue& expected = expected_value.GetDict();
  const base::DictValue& chains = *expected.FindDict("chains");
  EXPECT_EQ(chains.size(), inputs.EntropyNames().size());
  for (const std::string& name : inputs.EntropyNames()) {
    const base::DictValue& chain = *chains.FindDict(name);
    const std::string entropy = inputs.Entropy(name);
    Reply phrase = PhraseFromEntropy(entropy);
    EXPECT_EQ(phrase.status, ARDIA_STATUS_OK);
    EXPECT_EQ(phrase.data, Str(chain, "phrase")) << name;
    Keys keys(entropy);
    ASSERT_TRUE(keys.ok());
    EXPECT_EQ(keys.ChainTag(), Str(chain, "chainTag")) << name;
    const base::DictValue& tags = *chain.FindDict("scopeTags");
    EXPECT_EQ(tags.size(), inputs.Scopes().size());
    for (const std::string& scope : inputs.Scopes()) {
      EXPECT_EQ(keys.ScopeTag(scope), Str(tags, scope)) << name << " " << scope;
    }
  }

  const base::ListValue& passwords = *expected.FindList("passwords");
  size_t password_index = 0;
  for (const std::string& name : inputs.EntropyNames()) {
    Keys keys = inputs.MakeKeys(name);
    for (const base::Value& login_value : inputs.List("passwords")) {
      const base::DictValue& login = login_value.GetDict();
      ASSERT_LT(password_index, passwords.size());
      const base::DictValue& committed = passwords[password_index++].GetDict();
      EXPECT_EQ(Str(committed, "entropy"), name);
      EXPECT_EQ(Str(committed, "origin"), Str(login, "origin"));
      EXPECT_EQ(Str(committed, "username"), Str(login, "username"));
      EXPECT_EQ(Str(committed, "password"), Str(login, "password"));
      Reply sealed = keys.SealPassword(Str(login, "password"), Str(login, "origin"), Str(login, "username"));
      EXPECT_EQ(sealed.status, ARDIA_STATUS_OK);
      EXPECT_EQ(sealed.data, Str(committed, "sealed")) << name << " " << Str(login, "origin");
    }
  }
  EXPECT_EQ(password_index, passwords.size());
  EXPECT_EQ(passwords.size(), 6u);

  const base::ListValue& local_states = *expected.FindList("localStates");
  ASSERT_EQ(local_states.size(), inputs.List("localStates").size());
  EXPECT_EQ(local_states.size(), 2u);
  for (size_t index = 0; index < local_states.size(); ++index) {
    const base::DictValue& state = inputs.List("localStates")[index].GetDict();
    const base::DictValue& committed = local_states[index].GetDict();
    Keys keys = inputs.MakeKeys(Str(state, "entropy"));
    const std::string sealed = Base64(Str(committed, "sealed"));
    EXPECT_EQ(ToHex(sealed.substr(4, 12)), Str(state, "nonce"));
    EXPECT_EQ(sealed.size(), 4 + 12 + Padded(inputs.Payload(Str(state, "payload")).size()) + 16);
    Reply opened = keys.Open(sealed, "local", Str(state, "fileId"));
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK);
    EXPECT_EQ(opened.data, inputs.Payload(Str(state, "payload")));
    EXPECT_EQ(Str(committed, "entropy"), Str(state, "entropy"));
    EXPECT_EQ(Str(committed, "fileId"), Str(state, "fileId"));
  }

  std::set<std::string> built;
  const base::DictValue& vault = *expected.FindDict("vault");
  const base::ListValue& files = *vault.FindList("files");
  ASSERT_EQ(files.size(), inputs.List("vaultFiles").size());
  for (size_t index = 0; index < files.size(); ++index) {
    const base::DictValue& file = inputs.List("vaultFiles")[index].GetDict();
    Keys keys = inputs.MakeKeys(Str(file, "entropy"));
    const std::string scope = Str(file, "scope");
    const std::string id = Str(file, "id");
    const std::string path = VaultPath(keys, scope, FileName(id));
    EXPECT_EQ(path, Str(files[index].GetDict(), "path"));
    const std::string sealed = ReadFile(Vectors().AppendASCII(path));
    EXPECT_EQ(sealed.substr(0, 4), "NNS1");
    EXPECT_EQ(ToHex(sealed.substr(4, 12)), Str(file, "nonce")) << path;
    EXPECT_EQ(sealed.size(), 4 + 12 + Padded(inputs.Payload(Str(file, "payload")).size()) + 16) << path;
    Reply opened = keys.Open(sealed, keys.ScopeTag(scope), id);
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK) << path;
    EXPECT_EQ(opened.data, inputs.Payload(Str(file, "payload"))) << path;
    built.insert(path.substr(6));
  }
  const base::ListValue& damaged = *vault.FindList("damaged");
  ASSERT_EQ(damaged.size(), inputs.List("damaged").size());
  for (size_t index = 0; index < damaged.size(); ++index) {
    const base::DictValue& file = inputs.List("damaged")[index].GetDict();
    Keys keys = inputs.MakeKeys(Str(file, "entropy"));
    const std::string scope = Str(file, "scope");
    const std::string id = Str(file, "id");
    std::optional<int> flip = file.FindInt("flipByte");
    ASSERT_TRUE(flip.has_value());
    const std::string path = VaultPath(keys, scope, FileName(id));
    EXPECT_EQ(path, Str(damaged[index].GetDict(), "path"));
    const std::string sealed = ReadFile(Vectors().AppendASCII(path));
    EXPECT_EQ(keys.Open(sealed, keys.ScopeTag(scope), id).status, ARDIA_STATUS_AUTHENTICATION) << path;
    const std::string repaired = FlipBit(sealed, static_cast<size_t>(*flip), 1);
    EXPECT_EQ(ToHex(repaired.substr(4, 12)), Str(file, "nonce")) << path;
    Reply opened = keys.Open(repaired, keys.ScopeTag(scope), id);
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK) << path;
    EXPECT_EQ(opened.data, inputs.Payload(Str(file, "payload"))) << path;
    built.insert(path.substr(6));
  }
  const base::ListValue& pending = *vault.FindList("pending");
  ASSERT_EQ(pending.size(), inputs.List("pending").size());
  for (size_t index = 0; index < pending.size(); ++index) {
    const base::DictValue& file = inputs.List("pending")[index].GetDict();
    Keys keys = inputs.MakeKeys(Str(file, "entropy"));
    const std::string path = VaultPath(keys, Str(file, "scope"), "." + Str(file, "id") + ".nns.icloud");
    EXPECT_EQ(path, Str(pending[index].GetDict(), "path"));
    EXPECT_TRUE(ReadFile(Vectors().AppendASCII(path)).empty()) << path;
    built.insert(path.substr(6));
  }

  std::set<std::string> committed_tree;
  for (const auto& [path, bytes] : Tree(Vectors().AppendASCII("vault"))) {
    committed_tree.insert(path);
  }
  EXPECT_EQ(committed_tree.size(), 23u);
  EXPECT_EQ(built, committed_tree);
}

TEST_F(ArdiaCoreRsVectorsTest, PhrasesAndTagsRoundTrip) {
  Inputs inputs;
  base::Value expected = Expected();
  for (const auto [name, chain_value] : *expected.GetDict().FindDict("chains")) {
    const base::DictValue& chain = chain_value.GetDict();
    Reply entropy = PhraseToEntropy(Str(chain, "phrase"));
    EXPECT_EQ(entropy.status, ARDIA_STATUS_OK);
    EXPECT_EQ(ToHex(entropy.data), ToHex(inputs.Entropy(name)));
  }
}

TEST_F(ArdiaCoreRsVectorsTest, CommittedSealsOpenToTheirPlaintext) {
  Inputs inputs;
  base::Value expected_value = Expected();
  const base::DictValue& expected = expected_value.GetDict();
  size_t opened = 0;
  for (const base::Value& file_value : *expected.FindDict("vault")->FindList("files")) {
    const base::DictValue& file = file_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(file, "entropy"));
    Reply payload = keys.Open(ReadFile(Vectors().AppendASCII(Str(file, "path"))), keys.ScopeTag(Str(file, "scope")),
                              Str(file, "id"));
    EXPECT_EQ(payload.status, ARDIA_STATUS_OK) << Str(file, "path");
    EXPECT_EQ(payload.data, inputs.Payload(Str(file, "payload"))) << Str(file, "path");
    ++opened;
  }
  EXPECT_EQ(opened, 20u);
  for (const base::Value& state_value : *expected.FindList("localStates")) {
    const base::DictValue& state = state_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(state, "entropy"));
    Reply payload = keys.Open(Base64(Str(state, "sealed")), "local", Str(state, "fileId"));
    EXPECT_EQ(payload.status, ARDIA_STATUS_OK);
    EXPECT_EQ(payload.data, inputs.Payload(Str(state, "payload")));
  }
  for (const base::Value& login_value : *expected.FindList("passwords")) {
    const base::DictValue& login = login_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(login, "entropy"));
    Reply password = keys.OpenPassword(Str(login, "sealed"), Str(login, "origin"), Str(login, "username"));
    EXPECT_EQ(password.status, ARDIA_STATUS_OK);
    EXPECT_EQ(password.data, Str(login, "password"));
  }
}

TEST_F(ArdiaCoreRsVectorsTest, TheVaultReadsTheExactInventory) {
  Inputs inputs;
  base::Value expected_value = Expected();
  const base::DictValue& vault = *expected_value.GetDict().FindDict("vault");
  auto ids = [&](std::string_view kind, std::string_view entropy, std::string_view scope) {
    std::vector<std::string> out;
    for (const base::Value& entry : *vault.FindList(kind)) {
      if (Str(entry.GetDict(), "entropy") == entropy && Str(entry.GetDict(), "scope") == scope) {
        out.push_back(Str(entry.GetDict(), "id"));
      }
    }
    return Sorted(out);
  };
  for (const std::string& entropy : inputs.EntropyNames()) {
    Keys keys = inputs.MakeKeys(entropy);
    EXPECT_TRUE(base::DirectoryExists(Vectors().AppendASCII("vault").AppendASCII(keys.ChainTag())));
    for (const std::string& scope : inputs.Scopes()) {
      ScopeRead read = ReadScope(Vectors().AppendASCII("vault"), keys, scope);
      std::vector<std::string> read_ids;
      for (const auto& [id, payload] : read.files) {
        read_ids.push_back(id);
        bool found = false;
        for (const base::Value& entry : *vault.FindList("files")) {
          if (Str(entry.GetDict(), "id") == id) {
            found = true;
            EXPECT_EQ(payload, inputs.Payload(Str(entry.GetDict(), "payload"))) << id;
          }
        }
        EXPECT_TRUE(found) << id;
      }
      EXPECT_EQ(Sorted(read_ids), ids("files", entropy, scope));
      EXPECT_EQ(Sorted(read.damaged), ids("damaged", entropy, scope));
      EXPECT_EQ(Sorted(read.pending), ids("pending", entropy, scope));
      std::vector<std::string> all = ids("files", entropy, scope);
      for (const std::string& id : ids("damaged", entropy, scope)) {
        all.push_back(id);
      }
      for (const std::string& id : ids("pending", entropy, scope)) {
        all.push_back(id);
      }
      EXPECT_EQ(Sorted(read.present), Sorted(all));
    }
  }
}

TEST_F(ArdiaCoreRsVectorsTest, DamagedTamperedAndWrongContextSealsAreRejected) {
  Inputs inputs;
  base::Value expected_value = Expected();
  const base::DictValue& expected = expected_value.GetDict();
  const base::DictValue& vault = *expected.FindDict("vault");
  for (const base::Value& file_value : *vault.FindList("damaged")) {
    const base::DictValue& file = file_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(file, "entropy"));
    EXPECT_EQ(keys.Open(ReadFile(Vectors().AppendASCII(Str(file, "path"))), keys.ScopeTag(Str(file, "scope")),
                        Str(file, "id"))
                  .status,
              ARDIA_STATUS_AUTHENTICATION);
  }
  for (const base::Value& file_value : *vault.FindList("pending")) {
    EXPECT_TRUE(ReadFile(Vectors().AppendASCII(Str(file_value.GetDict(), "path"))).empty());
  }
  const std::vector<std::string> names = inputs.EntropyNames();
  const std::vector<std::string> scopes = inputs.Scopes();
  for (const base::Value& file_value : *vault.FindList("files")) {
    const base::DictValue& file = file_value.GetDict();
    const std::string& entropy = Str(file, "entropy");
    Keys keys = inputs.MakeKeys(entropy);
    Keys other = inputs.MakeKeys(*std::find_if(names.begin(), names.end(), [&](const std::string& name) {
      return name != entropy;
    }));
    const std::string& scope = Str(file, "scope");
    const std::string& other_scope = *std::find_if(scopes.begin(), scopes.end(), [&](const std::string& candidate) {
      return candidate != scope;
    });
    const std::string& id = Str(file, "id");
    const std::string sealed = ReadFile(Vectors().AppendASCII(Str(file, "path")));
    const std::string scope_tag = keys.ScopeTag(scope);
    EXPECT_EQ(keys.Open(sealed, keys.ScopeTag(other_scope), id).status, ARDIA_STATUS_AUTHENTICATION);
    EXPECT_EQ(keys.Open(sealed, scope_tag, "state").status, ARDIA_STATUS_AUTHENTICATION);
    EXPECT_EQ(other.Open(sealed, other.ScopeTag(scope), id).status, ARDIA_STATUS_AUTHENTICATION);
    for (size_t index : {size_t{4}, size_t{15}, size_t{16}, size_t{40}, sealed.size() - 1}) {
      EXPECT_EQ(keys.Open(FlipBit(sealed, index, 0x80), scope_tag, id).status, ARDIA_STATUS_AUTHENTICATION)
          << "byte " << index;
    }
    for (size_t index = 0; index < 4; ++index) {
      EXPECT_EQ(keys.Open(FlipBit(sealed, index, 0x80), scope_tag, id).status, ARDIA_STATUS_FORMAT);
    }
    EXPECT_EQ(keys.Open(sealed.substr(0, 35), scope_tag, id).status, ARDIA_STATUS_FORMAT);
  }
  for (const base::Value& state_value : *expected.FindList("localStates")) {
    const base::DictValue& state = state_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(state, "entropy"));
    const std::string sealed = Base64(Str(state, "sealed"));
    EXPECT_EQ(keys.Open(sealed, "local", "other").status, ARDIA_STATUS_AUTHENTICATION);
    EXPECT_EQ(keys.Open(sealed, keys.ScopeTag("app"), Str(state, "fileId")).status, ARDIA_STATUS_AUTHENTICATION);
  }
  for (const base::Value& login_value : *expected.FindList("passwords")) {
    const base::DictValue& login = login_value.GetDict();
    Keys keys = inputs.MakeKeys(Str(login, "entropy"));
    const std::string& sealed = Str(login, "sealed");
    const std::string& origin = Str(login, "origin");
    const std::string& username = Str(login, "username");
    EXPECT_EQ(keys.OpenPassword(sealed, origin + "x", username).status, ARDIA_STATUS_AUTHENTICATION);
    EXPECT_EQ(keys.OpenPassword(sealed, origin, username + "x").status, ARDIA_STATUS_AUTHENTICATION);
    std::string data = Base64(sealed);
    EXPECT_EQ(keys.OpenPassword(ToBase64(FlipBit(data, data.size() - 1, 1)), origin, username).status,
              ARDIA_STATUS_AUTHENTICATION);
    std::string versioned = data;
    versioned[0] = 2;
    EXPECT_EQ(keys.OpenPassword(ToBase64(versioned), origin, username).status, ARDIA_STATUS_FORMAT);
    EXPECT_EQ(keys.OpenPassword(sealed + "\n", origin, username).status, ARDIA_STATUS_FORMAT);
    std::string unpadded = sealed;
    while (!unpadded.empty() && unpadded.back() == '=') {
      unpadded.pop_back();
    }
    EXPECT_EQ(keys.OpenPassword(unpadded, origin, username).status == ARDIA_STATUS_OK,
              !base::EndsWith(sealed, "="));
  }
}

TEST_F(ArdiaCoreRsVectorsTest, RandomNoncesKeepTheFormatAndOpen) {
  Inputs inputs;
  Keys keys = inputs.MakeKeys("ordinary");
  const std::string scope_tag = keys.ScopeTag("app");
  for (std::string_view name : kVaultPayloads) {
    const std::string plain = inputs.Payload(name);
    Reply sealed = keys.Seal(plain, scope_tag, "f");
    EXPECT_EQ(sealed.status, ARDIA_STATUS_OK);
    EXPECT_EQ(sealed.data.size(), 4 + 12 + Padded(plain.size()) + 16) << name;
    EXPECT_EQ(sealed.data.substr(0, 4), "NNS1");
    Reply opened = keys.Open(sealed.data, scope_tag, "f");
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK);
    EXPECT_EQ(opened.data, plain);
    EXPECT_NE(keys.Seal(plain, scope_tag, "f").data, sealed.data);
  }
  Reply first = NewFileId();
  Reply second = NewFileId();
  EXPECT_EQ(first.status, ARDIA_STATUS_OK);
  EXPECT_EQ(first.data.size(), 26u);
  EXPECT_NE(first.data, second.data);
}

TEST_F(ArdiaCoreRsVectorsTest, SwiftAndKotlinRandomSetsOpen) {
  Inputs inputs;
  size_t checked = 0;
  for (std::string_view writer : {"swift", "kotlin"}) {
    const base::FilePath folder = Vectors().AppendASCII(writer);
    base::Value set_value = JsonFile(folder.AppendASCII("manifest.json"));
    const base::DictValue& set = set_value.GetDict();
    EXPECT_EQ(Str(set, "writer"), writer);
    const std::string entropy = Hex(Str(set, "entropy"));
    ASSERT_EQ(entropy.size(), 32u);
    EXPECT_EQ(PhraseFromEntropy(entropy).data, Str(set, "phrase"));
    EXPECT_EQ(ToHex(PhraseToEntropy(Str(set, "phrase")).data), ToHex(entropy));
    Keys keys(entropy);
    EXPECT_EQ(keys.ChainTag(), Str(set, "chainTag"));
    const base::DictValue& tags = *set.FindDict("scopeTags");
    std::vector<std::string> tag_scopes;
    for (const auto [scope, tag] : tags) {
      tag_scopes.push_back(scope);
      EXPECT_EQ(keys.ScopeTag(scope), tag.GetString());
    }
    EXPECT_EQ(Sorted(tag_scopes), Sorted(inputs.Scopes()));
    const base::ListValue& files = *set.FindList("files");
    std::set<std::string> listed;
    for (const std::string& scope : inputs.Scopes()) {
      std::vector<std::string> payloads;
      size_t mine = 0;
      for (const base::Value& file_value : files) {
        const base::DictValue& file = file_value.GetDict();
        if (Str(file, "scope") != scope) {
          continue;
        }
        ++mine;
        payloads.push_back(Str(file, "payload"));
        const std::string& id = Str(file, "id");
        EXPECT_EQ(Str(file, "path"), VaultPath(keys, scope, FileName(id)));
        listed.insert(Str(file, "path").substr(6));
        const std::string sealed = ReadFile(folder.AppendASCII(Str(file, "path")));
        EXPECT_EQ(sealed.substr(0, 4), "NNS1");
        Reply payload = keys.Open(sealed, keys.ScopeTag(scope), id);
        EXPECT_EQ(payload.status, ARDIA_STATUS_OK) << writer << " " << id;
        EXPECT_EQ(payload.data, inputs.Payload(Str(file, "payload")));
        EXPECT_EQ(keys.Open(sealed, keys.ScopeTag(scope), "state").status, ARDIA_STATUS_AUTHENTICATION);
        ++checked;
      }
      std::vector<std::string> expected_payloads(kVaultPayloads.begin(), kVaultPayloads.end());
      EXPECT_EQ(Sorted(payloads), Sorted(expected_payloads));
      ScopeRead read = ReadScope(folder.AppendASCII("vault"), keys, scope);
      EXPECT_TRUE(read.damaged.empty());
      EXPECT_TRUE(read.pending.empty());
      EXPECT_EQ(read.files.size(), mine);
    }
    std::set<std::string> on_disk;
    for (const auto& [path, bytes] : Tree(folder.AppendASCII("vault"))) {
      on_disk.insert(path);
    }
    EXPECT_EQ(on_disk, listed);
    const base::DictValue& login = *set.FindDict("password");
    const std::string& origin = Str(login, "origin");
    const std::string& username = Str(login, "username");
    const std::string& password = Str(login, "password");
    EXPECT_EQ(keys.OpenPassword(Str(set, "sealedPassword"), origin, username).data, password);
    EXPECT_EQ(keys.SealPassword(password, origin, username).data, Str(set, "sealedPassword"));
    const base::DictValue& local = *set.FindDict("localState");
    const std::string sealed = Base64(Str(local, "sealed"));
    Reply opened = keys.Open(sealed, "local", Str(local, "fileId"));
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK);
    EXPECT_EQ(opened.data, inputs.Payload(Str(local, "payload")));
    EXPECT_EQ(keys.Open(sealed, "local", "other").status, ARDIA_STATUS_AUTHENTICATION);
  }
  EXPECT_EQ(checked, 20u);
}

TEST_F(ArdiaCoreRsVectorsTest, MacAndWindowsInteropVaultsOpen) {
  const base::FilePath root = Fixtures().AppendASCII("windows-interop");
  std::string counting;
  for (uint8_t byte = 1; byte <= 32; ++byte) {
    counting.push_back(static_cast<char>(byte));
  }
  for (std::string_view writer : {"mac", "windows"}) {
    base::Value manifest_value = JsonFile(root.AppendASCII(std::string(writer) + ".json"));
    const base::DictValue& manifest = manifest_value.GetDict();
    const std::string entropy = Hex(Str(manifest, "entropy"));
    EXPECT_EQ(ToHex(entropy), ToHex(counting));
    const std::string words = base::JoinString(Strings(*manifest.FindList("words")), " ");
    EXPECT_EQ(PhraseFromEntropy(entropy).data, words);
    EXPECT_EQ(ToHex(PhraseToEntropy(words).data), ToHex(entropy));
    Keys keys(entropy);
    EXPECT_EQ(keys.ChainTag(), Str(manifest, "chainTag"));
    for (const auto [scope, tag] : *manifest.FindDict("scopeTags")) {
      EXPECT_EQ(keys.ScopeTag(scope), tag.GetString());
    }
    const base::ListValue& files = *manifest.FindList("files");
    EXPECT_EQ(files.size(), 2u);
    for (const base::Value& file_value : files) {
      const base::DictValue& file = file_value.GetDict();
      ScopeRead read = ReadScope(root.AppendASCII(writer), keys, Str(file, "scope"));
      EXPECT_TRUE(read.damaged.empty()) << writer;
      auto found = std::find_if(read.files.begin(), read.files.end(),
                                [&](const auto& entry) { return entry.first == Str(file, "id"); });
      ASSERT_NE(found, read.files.end()) << writer;
      EXPECT_EQ(Json(found->second), Json(Str(file, "payload"))) << writer;
    }
    const base::DictValue& local = *manifest.FindDict("local");
    Reply opened = keys.Open(Base64(Str(local, "sealed")), "local", "state");
    EXPECT_EQ(opened.status, ARDIA_STATUS_OK);
    EXPECT_EQ(opened.data, Str(local, "plain"));
    const base::DictValue& login = *manifest.FindDict("password");
    const std::string& origin = Str(login, "origin");
    const std::string& username = Str(login, "username");
    EXPECT_EQ(keys.OpenPassword(Str(login, "sealed"), origin, username).data, Str(login, "password"));
    EXPECT_EQ(keys.SealPassword(Str(login, "password"), origin, username).data, Str(login, "sealed"));
  }
}

TEST_F(ArdiaCoreRsVectorsTest, AVaultFileFrom0232StillOpens) {
  Keys keys(std::string(32, '\0'));
  EXPECT_EQ(keys.ChainTag(), "gbcx4r55mk3rlaegbggknyx4ta");
  EXPECT_EQ(keys.ScopeTag("app"), "nr4ncp5iyqzqgjn6ol4zksqtne");
  std::string encoded = ReadFile(Fixtures().AppendASCII("sealed-0.2.32.b64"));
  Reply opened = keys.Open(Base64(base::TrimWhitespaceASCII(encoded, base::TRIM_ALL)), keys.ScopeTag("app"), "f1");
  EXPECT_EQ(opened.status, ARDIA_STATUS_OK);
  EXPECT_EQ(opened.data, "from 0.2.32");
}

TEST_F(ArdiaCoreRsVectorsTest, PasswordNoncesComeFromThePaddedPlaintext) {
  Inputs inputs;
  Keys keys = inputs.MakeKeys("ordinary");
  base::Value expected = Expected();
  size_t checked = 0;
  for (const base::Value& login_value : *expected.GetDict().FindList("passwords")) {
    const base::DictValue& login = login_value.GetDict();
    if (Str(login, "entropy") != "ordinary") {
      continue;
    }
    const std::string& password = Str(login, "password");
    const std::string& sealed = Str(login, "sealed");
    EXPECT_EQ(Base64(sealed).size(), 1 + 12 + (4 + password.size() + 31) / 32 * 32 + 16);
    EXPECT_EQ(keys.SealPassword(password, Str(login, "origin"), Str(login, "username")).data, sealed);
    EXPECT_NE(keys.SealPassword(password, Str(login, "origin"), Str(login, "username") + "x").data.substr(0, 18),
              sealed.substr(0, 18));
    ++checked;
  }
  EXPECT_GT(checked, 0u);
}

TEST_F(ArdiaCoreRsVectorsTest, PhraseCasesReadAsSwiftDoes) {
  base::Value table = JsonFile(Repo().AppendASCII("packages/core-rs/tests/phrase-cases.json"));
  const base::ListValue& cases = *table.GetDict().FindList("cases");
  EXPECT_GE(cases.size(), 30u);
  for (const base::Value& case_value : cases) {
    const base::DictValue& phrase_case = case_value.GetDict();
    const std::string& name = Str(phrase_case, "name");
    const base::DictValue& swift = *phrase_case.FindDict("outcomes")->FindDict("swift");
    Reply reply = PhraseToEntropy(Str(phrase_case, "input"));
    if (const std::string* entropy = swift.FindString("entropy")) {
      EXPECT_EQ(reply.status, ARDIA_STATUS_OK) << name;
      EXPECT_EQ(ToHex(reply.data), *entropy) << name;
      continue;
    }
    EXPECT_EQ(reply.status, ARDIA_STATUS_PHRASE) << name;
    base::Value detail = Json(reply.data);
    EXPECT_EQ(Str(detail.GetDict(), "code"), Str(swift, "problem")) << name;
    EXPECT_FALSE(detail.GetDict().contains("word")) << name;
    if (std::optional<int> count = swift.FindInt("count")) {
      EXPECT_EQ(detail.GetDict().FindInt("count"), count) << name;
    }
    if (const std::string* word = swift.FindString("word")) {
      std::optional<int> index = detail.GetDict().FindInt("index");
      ASSERT_TRUE(index.has_value()) << name;
      const std::vector<std::string> tokens = Strings(*phrase_case.FindList("tokens"));
      ASSERT_LT(static_cast<size_t>(*index), tokens.size()) << name;
      EXPECT_EQ(tokens[static_cast<size_t>(*index)], *word) << name;
    }
  }
}

TEST_F(ArdiaCoreRsVectorsTest, PasswordReadsMatchSwift) {
  base::Value table_value = JsonFile(Repo().AppendASCII("packages/core-rs/tests/password-read-cases.json"));
  const base::DictValue& table = table_value.GetDict();
  Inputs inputs;
  Keys keys = inputs.MakeKeys(Str(table, "entropy"));
  const base::ListValue& cases = *table.FindList("cases");
  EXPECT_GE(cases.size(), 14u);
  for (const base::Value& case_value : cases) {
    const base::DictValue& read_case = case_value.GetDict();
    const std::string name = Str(read_case, "name");
    const base::DictValue& swift = *read_case.FindDict("outcomes")->FindDict("swift");
    Reply reply = keys.OpenPassword(Str(read_case, "sealed"), Str(read_case, "origin"), Str(read_case, "username"));
    if (const std::string* password = swift.FindString("password")) {
      EXPECT_EQ(reply.status, ARDIA_STATUS_OK) << name;
      EXPECT_EQ(reply.data, *password) << name;
    } else if (Str(swift, "error") == "format") {
      EXPECT_EQ(reply.status, ARDIA_STATUS_FORMAT) << name;
    } else {
      EXPECT_EQ(Str(swift, "error"), "authentication") << name;
      EXPECT_EQ(reply.status, ARDIA_STATUS_AUTHENTICATION) << name;
    }
    Reply sealed = keys.SealPassword(Str(read_case, "password"), Str(read_case, "origin"), Str(read_case, "username"));
    EXPECT_EQ(sealed.status, ARDIA_STATUS_OK) << name;
    std::string canonical;
    EXPECT_TRUE(base::Base64Decode(sealed.data, &canonical)) << name;
  }
}

TEST_F(ArdiaCoreRsVectorsTest, AnOutputSlotThatHoldsABufferIsLeftAlone) {
  Keys keys(std::string(32, '\2'));
  ASSERT_TRUE(keys.ok());
  Buf held;
  ASSERT_EQ(ardia_sync_new_file_id(held.out()), ARDIA_STATUS_OK);
  const std::string before = held.str();
  EXPECT_EQ(ardia_sync_new_file_id(held.out()), ARDIA_STATUS_OUTPUT_IN_USE);
  EXPECT_EQ(held.str(), before);
  ardia_sync_keys* existing = reinterpret_cast<ardia_sync_keys*>(&held);
  const std::string entropy(32, '\3');
  EXPECT_EQ(ardia_sync_keys_new(Ptr(entropy), entropy.size(), &existing), ARDIA_STATUS_OUTPUT_IN_USE);
  EXPECT_EQ(existing, reinterpret_cast<ardia_sync_keys*>(&held));
}

TEST_F(ArdiaCoreRsVectorsTest, InputsOverTheCapsAreRefused) {
  Keys keys(std::string(32, '\1'));
  ASSERT_TRUE(keys.ok());
  ardia_sync_keys* none = nullptr;
  EXPECT_EQ(ardia_sync_keys_new(Ptr("short"), 5, &none), ARDIA_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(none, nullptr);
  EXPECT_EQ(keys.Open(std::string(ARDIA_MAX_SEALED_FILE_BYTES + 1, 'x'), "local", "f").status,
            ARDIA_STATUS_TOO_LARGE);
  EXPECT_EQ(keys.Open("NNS1", std::string(ARDIA_MAX_LABEL_BYTES + 1, 'a'), "f").status, ARDIA_STATUS_TOO_LARGE);
  EXPECT_EQ(PhraseToEntropy(std::string(ARDIA_MAX_PHRASE_BYTES + 1, 'a')).status, ARDIA_STATUS_TOO_LARGE);
  EXPECT_EQ(VaultList("{\"names\":[],\"extra\":1}").status, ARDIA_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(ardia_sync_chain_tag(nullptr, nullptr), ARDIA_STATUS_INVALID_ARGUMENT);
}

}
