// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/import_core.h"

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <map>
#include <utility>

#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/memory/ptr_util.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "third_party/boringssl/src/include/openssl/cipher.h"
#include "third_party/boringssl/src/include/openssl/digest.h"
#include "third_party/boringssl/src/include/openssl/evp.h"
#include "third_party/boringssl/src/include/openssl/hmac.h"
#include "third_party/boringssl/src/include/openssl/mem.h"
#include "third_party/boringssl/src/include/openssl/sha.h"
#include "third_party/sqlite/sqlite3.h"

namespace ardia_linux::import {

namespace {

constexpr char kSaltySalt[] = "saltysalt";
constexpr char kBuiltInPassword[] = "peanuts";
constexpr base::TimeDelta kLookupDeadline = base::Seconds(5);
constexpr int kMaxRows = 1000000;

const uint8_t* Bytes(std::string_view text) {
  return reinterpret_cast<const uint8_t*>(text.data());
}

SecretText ChromiumKey(std::string_view password) {
  std::string key(16, '\0');
  PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.size(), Bytes(kSaltySalt),
                         sizeof(kSaltySalt) - 1, 1, key.size(),
                         reinterpret_cast<uint8_t*>(key.data()));
  return SecretText(std::move(key));
}

std::optional<SecretText> Decipher(const EVP_CIPHER* cipher,
                                   std::string_view key,
                                   std::string_view iv,
                                   std::string_view data,
                                   bool padded) {
  if (key.size() < EVP_CIPHER_key_length(cipher) ||
      iv.size() != EVP_CIPHER_iv_length(cipher)) {
    return std::nullopt;
  }
  bssl::ScopedEVP_CIPHER_CTX context;
  if (!EVP_DecryptInit_ex(context.get(), cipher, nullptr, Bytes(key),
                          Bytes(iv))) {
    return std::nullopt;
  }
  EVP_CIPHER_CTX_set_padding(context.get(), padded ? 1 : 0);
  SecretText out(std::string(data.size() + EVP_MAX_BLOCK_LENGTH, '\0'));
  int written = 0;
  int last = 0;
  uint8_t* target = reinterpret_cast<uint8_t*>(out.str().data());
  if (!EVP_DecryptUpdate(context.get(), target, &written, Bytes(data),
                         data.size()) ||
      !EVP_DecryptFinal_ex(context.get(), target + written, &last)) {
    return std::nullopt;
  }
  out.str().resize(written + last);
  if (!padded && !out.str().empty()) {
    const uint8_t pad = static_cast<uint8_t>(out.str().back());
    if (pad > 0 && pad <= 16 && pad <= out.str().size()) {
      out.str().resize(out.str().size() - pad);
    }
  }
  return out;
}

struct Der {
  uint8_t tag = 0;
  std::string_view body;
  std::vector<Der> children;
};

std::optional<Der> ParseDer(std::string_view buffer, size_t* at, int depth) {
  if (depth > 16 || *at + 2 > buffer.size()) {
    return std::nullopt;
  }
  Der node;
  node.tag = static_cast<uint8_t>(buffer[*at]);
  size_t length = static_cast<uint8_t>(buffer[*at + 1]);
  size_t start = *at + 2;
  if (length & 0x80) {
    const size_t count = length & 0x7f;
    if (count > 4 || start + count > buffer.size()) {
      return std::nullopt;
    }
    length = 0;
    for (size_t i = 0; i < count; ++i) {
      length = length * 256 + static_cast<uint8_t>(buffer[start + i]);
    }
    start += count;
  }
  if (start + length > buffer.size()) {
    return std::nullopt;
  }
  node.body = buffer.substr(start, length);
  if (node.tag == 0x30 || node.tag == 0x31 || node.tag == 0xa0) {
    size_t inner = 0;
    while (inner < node.body.size()) {
      std::optional<Der> child = ParseDer(node.body, &inner, depth + 1);
      if (!child) {
        return std::nullopt;
      }
      node.children.push_back(std::move(*child));
    }
  }
  *at = start + length;
  return node;
}

std::optional<Der> ParseDer(std::string_view buffer) {
  size_t at = 0;
  return ParseDer(buffer, &at, 0);
}

std::string Oid(const Der& node) {
  if (node.body.empty()) {
    return std::string();
  }
  const uint8_t first = static_cast<uint8_t>(node.body[0]);
  std::string out = base::NumberToString(first / 40) + "." +
                    base::NumberToString(first % 40);
  uint64_t value = 0;
  for (char c : node.body.substr(1)) {
    const uint8_t byte = static_cast<uint8_t>(c);
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      out += "." + base::NumberToString(value);
      value = 0;
    }
  }
  return out;
}

uint64_t Integer(const Der& node) {
  uint64_t value = 0;
  for (char c : node.body.substr(0, 8)) {
    value = value * 256 + static_cast<uint8_t>(c);
  }
  return value;
}

std::string Sha1(std::initializer_list<std::string_view> parts) {
  SHA_CTX context;
  SHA1_Init(&context);
  for (std::string_view part : parts) {
    SHA1_Update(&context, part.data(), part.size());
  }
  std::string out(SHA_DIGEST_LENGTH, '\0');
  SHA1_Final(reinterpret_cast<uint8_t*>(out.data()), &context);
  return out;
}

std::string HmacSha1(std::string_view key, std::string_view data) {
  std::string out(SHA_DIGEST_LENGTH, '\0');
  unsigned length = 0;
  HMAC(EVP_sha1(), key.data(), key.size(), Bytes(data), data.size(),
       reinterpret_cast<uint8_t*>(out.data()), &length);
  return out;
}

std::optional<SecretText> DecryptPbe(std::string_view encoded,
                                     std::string_view global_salt,
                                     const std::string& primary) {
  std::optional<Der> root = ParseDer(encoded);
  if (!root || root->children.size() < 2 ||
      root->children[0].children.size() < 2) {
    return std::nullopt;
  }
  const Der& algorithm = root->children[0];
  const Der& cipher_text = root->children[1];
  const std::string scheme = Oid(algorithm.children[0]);
  std::string password = Sha1({global_salt, primary});
  if (scheme == "1.2.840.113549.1.5.13") {
    const Der& params = algorithm.children[1];
    if (params.children.size() < 2 || params.children[0].children.size() < 2 ||
        params.children[1].children.size() < 2) {
      return std::nullopt;
    }
    const Der& kdf = params.children[0].children[1];
    const Der& cipher = params.children[1];
    if (kdf.children.size() < 2) {
      return std::nullopt;
    }
    const std::string_view salt = kdf.children[0].body;
    const uint64_t iterations = Integer(kdf.children[1]);
    const size_t key_length = kdf.children.size() > 2 &&
                                      kdf.children[2].tag == 0x02
                                  ? Integer(kdf.children[2])
                                  : 32;
    if (iterations == 0 || iterations > 10000000 || key_length != 32) {
      return std::nullopt;
    }
    std::string key(key_length, '\0');
    PKCS5_PBKDF2_HMAC(password.data(), password.size(), Bytes(salt),
                      salt.size(), iterations, EVP_sha256(), key.size(),
                      reinterpret_cast<uint8_t*>(key.data()));
    std::string iv = std::string("\x04\x0e", 2);
    iv += cipher.children[1].body;
    std::optional<SecretText> plain =
        Decipher(EVP_aes_256_cbc(), key, iv, cipher_text.body, false);
    OPENSSL_cleanse(key.data(), key.size());
    OPENSSL_cleanse(password.data(), password.size());
    return plain;
  }
  if (scheme == "1.2.840.113549.1.12.5.1.3") {
    const Der& params = algorithm.children[1];
    if (params.children.empty()) {
      return std::nullopt;
    }
    const std::string_view entry_salt = params.children[0].body;
    const std::string combined = Sha1({password, entry_salt});
    std::string padded_salt(entry_salt);
    padded_salt.resize(std::max<size_t>(20, entry_salt.size()), '\0');
    const std::string k1 =
        HmacSha1(combined, padded_salt + std::string(entry_salt));
    const std::string tk = HmacSha1(combined, padded_salt);
    const std::string k2 = HmacSha1(combined, tk + std::string(entry_salt));
    const std::string k = k1 + k2;
    OPENSSL_cleanse(password.data(), password.size());
    return Decipher(EVP_des_ede3_cbc(), std::string_view(k).substr(0, 24),
                    std::string_view(k).substr(32, 8), cipher_text.body,
                    false);
  }
  OPENSSL_cleanse(password.data(), password.size());
  return std::nullopt;
}

std::optional<std::string> RunCaptured(const std::vector<std::string>& argv) {
  int ends[2];
  if (pipe2(ends, O_CLOEXEC) != 0) {
    return std::nullopt;
  }
  base::ScopedFD read_end(ends[0]);
  base::ScopedFD write_end(ends[1]);
  base::ScopedFD nowhere(HANDLE_EINTR(open("/dev/null", O_RDWR | O_CLOEXEC)));
  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(write_end.get(), STDOUT_FILENO);
  if (nowhere.is_valid()) {
    options.fds_to_remap.emplace_back(nowhere.get(), STDERR_FILENO);
  }
  base::Process child = base::LaunchProcess(argv, options);
  write_end.reset();
  if (!child.IsValid()) {
    return std::nullopt;
  }
  std::string out;
  const base::TimeTicks deadline = base::TimeTicks::Now() + kLookupDeadline;
  bool done = false;
  while (!done) {
    const int left = static_cast<int>(
        (deadline - base::TimeTicks::Now()).InMilliseconds());
    if (left <= 0) {
      break;
    }
    struct pollfd wait = {read_end.get(), POLLIN, 0};
    if (HANDLE_EINTR(poll(&wait, 1, left)) <= 0) {
      break;
    }
    char buffer[4096];
    const ssize_t got = HANDLE_EINTR(read(read_end.get(), buffer, sizeof(buffer)));
    if (got <= 0) {
      done = true;
    } else if (out.size() < 64 * 1024) {
      out.append(buffer, got);
    }
  }
  int exit_code = -1;
  if (!done || !child.WaitForExitWithTimeout(base::Seconds(1), &exit_code)) {
    kill(child.Pid(), SIGKILL);
    child.WaitForExit(&exit_code);
    Cleanse(out);
    return std::nullopt;
  }
  if (exit_code != 0) {
    Cleanse(out);
    return std::nullopt;
  }
  if (!out.empty() && out.back() == '\n') {
    out.pop_back();
  }
  if (out.empty()) {
    return std::nullopt;
  }
  return out;
}

int Authorize(void*, int action, const char* first, const char* second,
              const char*, const char*) {
  switch (action) {
    case SQLITE_SELECT:
    case SQLITE_READ:
    case SQLITE_FUNCTION:
    case SQLITE_RECURSIVE:
      return SQLITE_OK;
    case SQLITE_PRAGMA: {
      const std::string_view name = first ? first : "";
      const bool reading = !second && (name == "table_info" ||
                                       name == "table_xinfo" ||
                                       name == "user_version" ||
                                       name == "schema_version");
      return reading ? SQLITE_OK : SQLITE_DENY;
    }
    default:
      return SQLITE_DENY;
  }
}

base::Value Cell(sqlite3_stmt* statement, int column) {
  switch (sqlite3_column_type(statement, column)) {
    case SQLITE_INTEGER:
      return base::Value(
          static_cast<double>(sqlite3_column_int64(statement, column)));
    case SQLITE_FLOAT:
      return base::Value(sqlite3_column_double(statement, column));
    case SQLITE_TEXT: {
      const char* text =
          reinterpret_cast<const char*>(sqlite3_column_text(statement, column));
      std::string value(text ? text : "",
                        sqlite3_column_bytes(statement, column));
      if (!base::IsStringUTF8AllowingNoncharacters(value)) {
        value = ValidUtf8(value);
      }
      return base::Value(std::move(value));
    }
    case SQLITE_BLOB: {
      const void* blob = sqlite3_column_blob(statement, column);
      const int size = sqlite3_column_bytes(statement, column);
      return base::Value(base::DictValue().Set(
          "blob", base::Base64Encode(std::string_view(
                      static_cast<const char*>(blob), blob ? size : 0))));
    }
    default:
      return base::Value();
  }
}

std::string RawText(sqlite3_stmt* statement, int column) {
  const void* data = sqlite3_column_blob(statement, column);
  const int size = sqlite3_column_bytes(statement, column);
  return data ? std::string(static_cast<const char*>(data), size)
              : std::string();
}

bool CopyIfThere(const base::FilePath& from, const base::FilePath& to) {
  return !base::PathExists(from) || base::CopyFile(from, to);
}

}

SecretText::SecretText() = default;
SecretText::SecretText(std::string text) : text_(std::move(text)) {}
SecretText::SecretText(SecretText&& other) : text_(std::move(other.text_)) {
  Cleanse(other.text_);
}
SecretText& SecretText::operator=(SecretText&& other) {
  if (this != &other) {
    Cleanse(text_);
    text_ = std::move(other.text_);
    Cleanse(other.text_);
  }
  return *this;
}
SecretText::~SecretText() {
  Cleanse(text_);
}

void Cleanse(std::string& text) {
  if (text.capacity()) {
    text.resize(text.capacity());
    OPENSSL_cleanse(text.data(), text.size());
  }
  text.clear();
}

std::string ValidUtf8(std::string_view text) {
  if (base::IsStringUTF8AllowingNoncharacters(text)) {
    return std::string(text);
  }
  return base::UTF16ToUTF8(base::UTF8ToUTF16(text));
}

void CleanseValue(base::Value& value) {
  if (value.is_string()) {
    Cleanse(value.GetString());
  } else if (value.is_blob()) {
    if (!value.GetBlob().empty()) {
      OPENSSL_cleanse(value.GetBlob().data(), value.GetBlob().size());
    }
  } else if (value.is_list()) {
    for (base::Value& item : value.GetList()) {
      CleanseValue(item);
    }
  } else if (value.is_dict()) {
    for (auto [name, item] : value.GetDict()) {
      CleanseValue(item);
    }
  }
}

bool IsWithin(const base::FilePath& root, const base::FilePath& path) {
  return path == root || root.IsParent(path);
}

std::optional<base::FilePath> ConfinedPath(const base::FilePath& root,
                                           std::string_view path) {
  base::FilePath asked(path);
  if (!asked.IsAbsolute() || asked.ReferencesParent()) {
    return std::nullopt;
  }
  base::FilePath real = base::MakeAbsoluteFilePath(asked);
  if (real.empty()) {
    real = asked;
  }
  if (!IsWithin(root, real)) {
    return std::nullopt;
  }
  return real;
}

std::optional<base::FilePath> ConfinedWithin(const base::FilePath& root,
                                             std::string_view folder,
                                             std::string_view path) {
  std::optional<base::FilePath> base = ConfinedPath(root, folder);
  if (!base) {
    return std::nullopt;
  }
  base::FilePath relative(path);
  base::FilePath joined = relative.IsAbsolute() ? relative : base->Append(path);
  if (joined.ReferencesParent()) {
    return std::nullopt;
  }
  std::optional<base::FilePath> real = ConfinedPath(root, joined.value());
  if (!real || !IsWithin(*base, *real)) {
    return std::nullopt;
  }
  return real;
}

Snapshot::Snapshot() = default;

Snapshot::~Snapshot() {
  if (db_) {
    sqlite3_close_v2(db_.ExtractAsDangling());
  }
}

std::unique_ptr<Snapshot> Snapshot::Open(const base::FilePath& path,
                                         std::string* failure) {
  if (!base::PathExists(path)) {
    *failure = "missing";
    return nullptr;
  }
  auto snapshot = base::WrapUnique(new Snapshot());
  if (!snapshot->folder_.CreateUniqueTempDir()) {
    *failure = "noTemp";
    return nullptr;
  }
  const base::FilePath copy = snapshot->folder_.GetPath().Append("db");
  if (!base::CopyFile(path, copy) ||
      !CopyIfThere(base::FilePath(path.value() + "-wal"),
                   base::FilePath(copy.value() + "-wal")) ||
      !CopyIfThere(base::FilePath(path.value() + "-journal"),
                   base::FilePath(copy.value() + "-journal"))) {
    *failure = "unreadable";
    return nullptr;
  }
  sqlite3_initialize();
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(copy.value().c_str(), &db,
                      SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX,
                      nullptr) != SQLITE_OK) {
    if (db) {
      sqlite3_close_v2(db);
    }
    *failure = "unreadable";
    return nullptr;
  }
  snapshot->db_ = db;
  sqlite3_busy_timeout(db, 2000);
  sqlite3_exec(db, "PRAGMA query_only = ON", nullptr, nullptr, nullptr);
  sqlite3_set_authorizer(db, &Authorize, nullptr);
  return snapshot;
}

base::DictValue Snapshot::Run(const base::ListValue& queries) {
  base::ListValue results;
  for (const base::Value& query : queries) {
    base::DictValue rows;
    base::ListValue columns;
    base::ListValue cells;
    const base::DictValue* dict = query.GetIfDict();
    const std::string* sql = dict ? dict->FindString("sql") : nullptr;
    const int limit = dict ? dict->FindInt("limit").value_or(kMaxRows)
                           : kMaxRows;
    sqlite3_stmt* statement = nullptr;
    if (!sql || sqlite3_prepare_v2(db_, sql->c_str(), -1, &statement,
                                   nullptr) != SQLITE_OK) {
      rows.Set("columns", base::ListValue());
      rows.Set("rows", base::ListValue());
      rows.Set("error", sqlite3_errmsg(db_));
      results.Append(std::move(rows));
      continue;
    }
    if (const base::ListValue* args = dict->FindList("args")) {
      for (size_t i = 0; i < args->size(); ++i) {
        const base::Value& arg = (*args)[i];
        if (arg.is_string()) {
          sqlite3_bind_text(statement, i + 1, arg.GetString().c_str(),
                            arg.GetString().size(), SQLITE_TRANSIENT);
        } else if (arg.is_int()) {
          sqlite3_bind_int64(statement, i + 1, arg.GetInt());
        } else if (arg.is_double()) {
          sqlite3_bind_double(statement, i + 1, arg.GetDouble());
        }
      }
    }
    const int count = sqlite3_column_count(statement);
    for (int column = 0; column < count; ++column) {
      const char* name = sqlite3_column_name(statement, column);
      columns.Append(name ? name : "");
    }
    int step = SQLITE_ROW;
    int taken = 0;
    while (taken < std::min(limit, kMaxRows) &&
           (step = sqlite3_step(statement)) == SQLITE_ROW) {
      base::ListValue row;
      for (int column = 0; column < count; ++column) {
        row.Append(Cell(statement, column));
      }
      cells.Append(std::move(row));
      ++taken;
    }
    rows.Set("columns", std::move(columns));
    rows.Set("rows", std::move(cells));
    if (step != SQLITE_ROW && step != SQLITE_DONE) {
      rows.Set("error", sqlite3_errmsg(db_));
    }
    sqlite3_finalize(statement);
    results.Append(std::move(rows));
  }
  return base::DictValue().Set("results", std::move(results));
}

std::vector<base::DictValue> Snapshot::Rows(
    std::string_view sql,
    const std::vector<std::string>& args) {
  std::vector<base::DictValue> out;
  sqlite3_stmt* statement = nullptr;
  if (sqlite3_prepare_v2(db_, std::string(sql).c_str(), -1, &statement,
                         nullptr) != SQLITE_OK) {
    return out;
  }
  for (size_t i = 0; i < args.size(); ++i) {
    sqlite3_bind_text(statement, i + 1, args[i].c_str(), args[i].size(),
                      SQLITE_TRANSIENT);
  }
  const int count = sqlite3_column_count(statement);
  while (sqlite3_step(statement) == SQLITE_ROW) {
    base::DictValue row;
    for (int column = 0; column < count; ++column) {
      const char* name = sqlite3_column_name(statement, column);
      const int type = sqlite3_column_type(statement, column);
      if (type == SQLITE_INTEGER) {
        row.Set(name, static_cast<double>(sqlite3_column_int64(statement,
                                                               column)));
      } else if (type == SQLITE_FLOAT) {
        row.Set(name, sqlite3_column_double(statement, column));
      } else if (type == SQLITE_NULL) {
        row.Set(name, base::Value());
      } else {
        std::string raw = RawText(statement, column);
        row.Set(name,
                base::Value(base::Value::BlobStorage(raw.begin(), raw.end())));
        Cleanse(raw);
      }
    }
    out.push_back(std::move(row));
  }
  sqlite3_finalize(statement);
  return out;
}

bool Snapshot::HasTable(std::string_view table) {
  return !Rows("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
               {std::string(table)})
              .empty();
}

ChromiumKeys::ChromiumKeys() = default;
ChromiumKeys::ChromiumKeys(ChromiumKeys&&) = default;
ChromiumKeys& ChromiumKeys::operator=(ChromiumKeys&&) = default;
ChromiumKeys::~ChromiumKeys() = default;

ChromiumKeys KeysFromPassword(const std::optional<std::string>& keyring) {
  ChromiumKeys keys;
  keys.v10.push_back(ChromiumKey(kBuiltInPassword));
  keys.v10.push_back(ChromiumKey(""));
  if (keyring) {
    keys.v11.push_back(ChromiumKey(*keyring));
    keys.from_keyring = true;
  }
  keys.v11.push_back(ChromiumKey(""));
  return keys;
}

std::optional<std::string> KeyringPassword(std::string_view application) {
  static const std::map<std::string_view, std::string_view> kWallets = {
      {"chrome", "Chrome"},   {"chromium", "Chromium"},
      {"brave", "Brave"},     {"Microsoft Edge", "Microsoft Edge"},
      {"vivaldi", "Vivaldi"}, {"opera", "Opera"},
  };
  if (application.empty()) {
    return std::nullopt;
  }
  if (std::optional<std::string> secret = RunCaptured(
          {"secret-tool", "lookup", "application", std::string(application)})) {
    return secret;
  }
  auto wallet = kWallets.find(application);
  if (wallet == kWallets.end()) {
    return std::nullopt;
  }
  std::optional<std::string> found = RunCaptured(
      {"kwallet-query", "-r", std::string(wallet->second) + " Safe Storage",
       "-f", std::string(wallet->second) + " Keys", "kdewallet"});
  if (found) {
    const std::string lower = base::ToLowerASCII(*found);
    if (lower.find("failed") != std::string::npos ||
        lower.find("not found") != std::string::npos) {
      Cleanse(*found);
      return std::nullopt;
    }
  }
  return found;
}

Decrypted DecryptChromium(std::string_view blob, const ChromiumKeys& keys) {
  Decrypted result;
  if (blob.empty()) {
    result.value = SecretText();
    return result;
  }
  const std::string_view prefix = blob.substr(0, 3);
  if (prefix == "v20") {
    result.reason = Undecrypted::kAppBound;
    return result;
  }
  if (prefix != "v10" && prefix != "v11") {
    result.value = SecretText(std::string(blob));
    return result;
  }
  const std::string iv(16, ' ');
  for (const SecretText& key : prefix == "v10" ? keys.v10 : keys.v11) {
    if (std::optional<SecretText> plain = Decipher(
            EVP_aes_128_cbc(), key.str(), iv, blob.substr(3), true)) {
      result.value = std::move(plain);
      return result;
    }
  }
  result.reason = Undecrypted::kUndecryptable;
  return result;
}

FirefoxKey FirefoxKeyFrom(Snapshot& key4, const std::string& primary) {
  FirefoxKey result;
  std::vector<base::DictValue> meta =
      key4.Rows("SELECT item1, item2 FROM metadata WHERE id = 'password'");
  const base::Value* salt = meta.empty() ? nullptr : meta[0].Find("item1");
  const base::Value* check = meta.empty() ? nullptr : meta[0].Find("item2");
  if (!salt || !check || !salt->is_blob() || !check->is_blob()) {
    result.error = "key4.db has no password entry";
    return result;
  }
  const std::string global_salt(salt->GetBlob().begin(), salt->GetBlob().end());
  const std::string encoded(check->GetBlob().begin(), check->GetBlob().end());
  std::optional<SecretText> checked = DecryptPbe(encoded, global_salt, primary);
  if (!checked || !checked->str().starts_with("password-check")) {
    result.locked = true;
    return result;
  }
  static constexpr std::string_view kCkaId(
      "\xf8\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x01", 16);
  std::string sealed;
  bool found = false;
  std::vector<base::DictValue> rows =
      key4.Rows("SELECT a11, a102, a3 FROM nssPrivate");
  for (base::DictValue& row : rows) {
    const base::Value* a11 = row.Find("a11");
    if (!a11 || !a11->is_blob()) {
      continue;
    }
    auto bytes_of = [&](std::string_view column) {
      const base::Value* value = row.Find(column);
      if (!value) {
        return std::string();
      }
      if (value->is_blob()) {
        return std::string(value->GetBlob().begin(), value->GetBlob().end());
      }
      return value->is_string() ? value->GetString() : std::string();
    };
    if (bytes_of("a3") == "as-logins-key") {
      continue;
    }
    const bool login_key = bytes_of("a102") == kCkaId;
    if (!found || login_key) {
      Cleanse(sealed);
      sealed = std::string(a11->GetBlob().begin(), a11->GetBlob().end());
      found = true;
    }
    if (login_key) {
      break;
    }
  }
  for (base::DictValue& row : rows) {
    base::Value wiped(std::move(row));
    CleanseValue(wiped);
  }
  if (!found) {
    result.error = "key4.db holds no login key";
    return result;
  }
  std::optional<SecretText> key = DecryptPbe(sealed, global_salt, primary);
  Cleanse(sealed);
  if (!key || key->str().size() < 24) {
    result.error = "key4.db login key is malformed";
    return result;
  }
  result.key = std::move(key);
  return result;
}

std::optional<SecretText> DecryptLoginField(std::string_view base64,
                                            const SecretText& key) {
  std::string raw;
  if (!base::Base64Decode(base64, &raw)) {
    return std::nullopt;
  }
  std::optional<Der> root = ParseDer(raw);
  if (!root || root->children.size() < 3 ||
      root->children[1].children.size() < 2) {
    return std::nullopt;
  }
  const Der& algorithm = root->children[1];
  const std::string scheme = Oid(algorithm.children[0]);
  const std::string_view iv = algorithm.children[1].body;
  const std::string_view cipher_text = root->children[2].body;
  std::optional<SecretText> plain;
  if (scheme == "1.2.840.113549.3.7" && key.str().size() >= 24) {
    plain = Decipher(EVP_des_ede3_cbc(), std::string_view(key.str()).substr(0, 24),
                     iv, cipher_text, false);
  } else if (scheme == "2.16.840.1.101.3.4.1.42" && key.str().size() >= 32) {
    plain = Decipher(EVP_aes_256_cbc(), std::string_view(key.str()).substr(0, 32),
                     iv, cipher_text, false);
  }
  Cleanse(raw);
  return plain;
}

}
