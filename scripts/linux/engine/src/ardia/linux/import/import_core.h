// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_IMPORT_IMPORT_CORE_H_
#define ARDIA_LINUX_IMPORT_IMPORT_CORE_H_

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/scoped_temp_dir.h"
#include "base/memory/raw_ptr.h"
#include "base/values.h"

struct sqlite3;

namespace ardia_linux::import {

class SecretText {
 public:
  SecretText();
  explicit SecretText(std::string text);
  SecretText(SecretText&&);
  SecretText& operator=(SecretText&&);
  SecretText(const SecretText&) = delete;
  SecretText& operator=(const SecretText&) = delete;
  ~SecretText();

  const std::string& str() const { return text_; }
  std::string& str() { return text_; }

 private:
  std::string text_;
};

void Cleanse(std::string& text);
std::string ValidUtf8(std::string_view text);
void CleanseValue(base::Value& value);

bool IsWithin(const base::FilePath& root, const base::FilePath& path);

std::optional<base::FilePath> ConfinedPath(const base::FilePath& root,
                                           std::string_view path);

std::optional<base::FilePath> ConfinedWithin(const base::FilePath& root,
                                             std::string_view folder,
                                             std::string_view path);

class Snapshot {
 public:
  static std::unique_ptr<Snapshot> Open(const base::FilePath& path,
                                        std::string* failure);
  Snapshot(const Snapshot&) = delete;
  Snapshot& operator=(const Snapshot&) = delete;
  ~Snapshot();

  base::DictValue Run(const base::ListValue& queries);
  std::vector<base::DictValue> Rows(std::string_view sql,
                                    const std::vector<std::string>& args = {});
  bool HasTable(std::string_view table);

 private:
  Snapshot();

  base::ScopedTempDir folder_;
  raw_ptr<sqlite3> db_ = nullptr;
};

struct ChromiumKeys {
  ChromiumKeys();
  ChromiumKeys(ChromiumKeys&&);
  ChromiumKeys& operator=(ChromiumKeys&&);
  ~ChromiumKeys();

  std::vector<SecretText> v10;
  std::vector<SecretText> v11;
  bool from_keyring = false;
};

ChromiumKeys KeysFromPassword(const std::optional<std::string>& keyring);

std::optional<std::string> KeyringPassword(std::string_view application);

enum class Undecrypted { kNone, kUndecryptable, kAppBound };

struct Decrypted {
  std::optional<SecretText> value;
  Undecrypted reason = Undecrypted::kNone;
};

Decrypted DecryptChromium(std::string_view blob, const ChromiumKeys& keys);

struct FirefoxKey {
  std::optional<SecretText> key;
  bool locked = false;
  std::string error;
};

FirefoxKey FirefoxKeyFrom(Snapshot& key4, const std::string& primary_password);

std::optional<SecretText> DecryptLoginField(std::string_view base64,
                                            const SecretText& key);

}

#endif
