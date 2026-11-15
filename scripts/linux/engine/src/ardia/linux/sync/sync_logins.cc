// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/sync/sync_logins.h"

#include <set>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"

namespace ardia_linux::sync {

namespace {

constexpr std::string_view kPrefix = "pw:";

bool MentionsLogins(std::string_view json) {
  return json.find("\"pw:") != std::string_view::npos ||
         json.find("\\u") != std::string_view::npos;
}

class Rewrite {
 public:
  Rewrite(const Keys& keys, bool hiding) : keys_(keys), hiding_(hiding) {}

  bool Walk(base::Value& node) {
    if (node.is_list()) {
      for (base::Value& item : node.GetList()) {
        if (!Walk(item)) {
          return false;
        }
      }
      return true;
    }
    if (!node.is_dict()) {
      return true;
    }
    base::DictValue& dict = node.GetDict();
    const std::string* key = dict.FindString("k");
    if (key && key->starts_with(kPrefix) && dict.Find("v")) {
      return Login(*dict.Find("v"));
    }
    std::vector<std::string> dropped;
    for (auto [name, value] : dict) {
      if (!name.starts_with(kPrefix)) {
        if (!Walk(value)) {
          return false;
        }
        continue;
      }
      if (value.is_string()) {
        dropped.push_back(name);
        continue;
      }
      if (value.is_dict() && value.GetDict().Find("v")) {
        if (!Login(*value.GetDict().Find("v"))) {
          return false;
        }
      }
    }
    for (const std::string& name : dropped) {
      if (base::Value* value = dict.Find(name)) {
        CleanseValue(*value);
      }
      dict.Remove(name);
    }
    return true;
  }

 private:
  bool Login(base::Value& login) {
    if (!login.is_dict()) {
      return true;
    }
    base::DictValue& fields = login.GetDict();
    const std::string* origin = fields.FindString("o");
    const std::string* username = fields.FindString("u");
    std::string* secret = fields.FindString(hiding_ ? "p" : "s");
    if (!origin || !username || !secret) {
      if (hiding_ && fields.Find("p")) {
        CleanseValue(*fields.Find("p"));
        fields.Remove("p");
      }
      return true;
    }
    if (hiding_) {
      std::optional<std::string> sealed =
          keys_.SealPassword(*secret, *origin, *username);
      if (!sealed) {
        return false;
      }
      Wipe(*secret);
      fields.Remove("p");
      fields.Set("s", std::move(*sealed));
      return true;
    }
    std::optional<Secret> opened =
        keys_.OpenPassword(*secret, *origin, *username);
    if (!opened) {
      return false;
    }
    fields.Remove("s");
    fields.Set("p", opened->str());
    return true;
  }

  const Keys& keys_;
  const bool hiding_;
};

std::optional<base::Value> Parse(std::string_view json) {
  return base::JSONReader::Read(json, base::JSON_PARSE_RFC);
}

}

void CleanseValue(base::Value& value) {
  if (value.is_string()) {
    Wipe(value.GetString());
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

std::optional<std::string> HidePasswords(std::string_view json,
                                         const Keys& keys) {
  if (!MentionsLogins(json)) {
    return std::string(json);
  }
  std::optional<base::Value> root = Parse(json);
  if (!root) {
    return std::nullopt;
  }
  std::optional<std::string> out;
  if (Rewrite(keys, true).Walk(*root)) {
    out = base::WriteJson(*root);
  }
  CleanseValue(*root);
  return out;
}

std::optional<Secret> RestorePasswords(std::string_view json,
                                       const Keys& keys) {
  if (!MentionsLogins(json)) {
    return Secret(std::string(json));
  }
  std::optional<base::Value> root = Parse(json);
  if (!root) {
    return std::nullopt;
  }
  std::optional<Secret> out;
  if (Rewrite(keys, false).Walk(*root)) {
    if (std::optional<std::string> written = base::WriteJson(*root)) {
      out = Secret(std::move(*written));
    }
  }
  CleanseValue(*root);
  return out;
}

std::optional<std::string> LoginOrigin(std::string_view realm) {
  if (!realm.empty() && realm.back() == '/') {
    realm.remove_suffix(1);
  }
  const size_t start = realm.starts_with("https://")  ? 8
                       : realm.starts_with("http://") ? 7
                                                       : 0;
  if (start == 0 || start == realm.size()) {
    return std::nullopt;
  }
  for (char c : realm.substr(start)) {
    if (c == '/' || c == ' ' || c == '\t' || c == '\n' || c == '\r' ||
        c == '\f' || c == '\v') {
      return std::nullopt;
    }
  }
  return std::string(realm);
}

std::optional<base::ListValue> SealedLogins(std::string_view reply,
                                            const Keys& keys) {
  std::optional<base::Value> root = Parse(reply);
  if (!root || !root->is_dict()) {
    return std::nullopt;
  }
  std::optional<base::ListValue> out = base::ListValue();
  const base::ListValue* logins = root->GetDict().FindList("logins");
  if (!logins) {
    out.reset();
  } else {
    std::set<std::string> seen;
    for (const base::Value& login : *logins) {
      const base::DictValue* fields = login.GetIfDict();
      const std::string* realm = fields ? fields->FindString("realm") : nullptr;
      const std::string* username =
          fields ? fields->FindString("username") : nullptr;
      const std::string* password =
          fields ? fields->FindString("password") : nullptr;
      const base::Value* created = fields ? fields->Find("created") : nullptr;
      if (!realm || !username || !password || !created ||
          !(created->is_int() || created->is_double())) {
        out.reset();
        break;
      }
      if (!seen.insert(*realm + std::string(1, '\0') + *username).second) {
        continue;
      }
      std::optional<std::string> origin = LoginOrigin(*realm);
      if (!origin) {
        continue;
      }
      std::optional<std::string> sealed =
          keys.SealPassword(*password, *origin, *username);
      if (!sealed) {
        out.reset();
        break;
      }
      out->Append(base::DictValue()
                      .Set("origin", *origin)
                      .Set("username", *username)
                      .Set("sealed", std::move(*sealed))
                      .Set("created", created->Clone()));
    }
  }
  CleanseValue(*root);
  return out;
}

std::optional<Secret> SavedPassword(std::string_view reply,
                                    std::string_view origin,
                                    std::string_view username) {
  std::optional<base::Value> root = Parse(reply);
  if (!root || !root->is_dict()) {
    return std::nullopt;
  }
  std::optional<Secret> found;
  if (const base::ListValue* logins = root->GetDict().FindList("logins")) {
    for (const base::Value& login : *logins) {
      const base::DictValue* fields = login.GetIfDict();
      const std::string* realm = fields ? fields->FindString("realm") : nullptr;
      const std::string* user =
          fields ? fields->FindString("username") : nullptr;
      const std::string* password =
          fields ? fields->FindString("password") : nullptr;
      if (!realm || !user || !password || *user != username) {
        continue;
      }
      std::optional<std::string> login_origin = LoginOrigin(*realm);
      if (login_origin && *login_origin == origin) {
        found = Secret(*password);
        break;
      }
    }
  }
  CleanseValue(*root);
  return found;
}

Secret LoginArgs(std::string_view origin,
                 std::string_view username,
                 std::optional<std::string_view> password) {
  base::Value args(base::DictValue()
                       .Set("origin", origin)
                       .Set("username", username));
  if (password) {
    args.GetDict().Set("password", *password);
  }
  Secret json(base::WriteJson(args).value_or("{}"));
  CleanseValue(args);
  return json;
}

}
