// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/electron_keyring.h"

#include <memory>
#include <utility>

#include "base/containers/span.h"
#include "base/memory/scoped_refptr.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_path.h"
#include "dbus/object_proxy.h"

namespace ardia_linux {

namespace {

constexpr char kSecretsService[] = "org.freedesktop.secrets";
constexpr char kSecretsPath[] = "/org/freedesktop/secrets";
constexpr char kServiceInterface[] = "org.freedesktop.Secret.Service";
constexpr int kTimeoutMs = 5000;

std::unique_ptr<dbus::Response> Call(dbus::ObjectProxy* proxy,
                                     dbus::MethodCall* call) {
  auto reply = proxy->CallMethodAndBlock(call, kTimeoutMs);
  return reply.has_value() ? std::move(reply.value()) : nullptr;
}

std::optional<dbus::ObjectPath> OpenPlainSession(dbus::ObjectProxy* service) {
  dbus::MethodCall open(kServiceInterface, "OpenSession");
  dbus::MessageWriter writer(&open);
  writer.AppendString("plain");
  writer.AppendVariantOfString("");
  std::unique_ptr<dbus::Response> reply = Call(service, &open);
  if (!reply) {
    return std::nullopt;
  }
  dbus::MessageReader reader(reply.get());
  dbus::MessageReader output(nullptr);
  dbus::ObjectPath session;
  if (!reader.PopVariant(&output) || !reader.PopObjectPath(&session)) {
    return std::nullopt;
  }
  return session;
}

std::vector<dbus::ObjectPath> UnlockedItems(dbus::ObjectProxy* service,
                                            const std::string& application) {
  dbus::MethodCall search(kServiceInterface, "SearchItems");
  dbus::MessageWriter writer(&search);
  dbus::MessageWriter attributes(nullptr);
  writer.OpenArray("{ss}", &attributes);
  dbus::MessageWriter entry(nullptr);
  attributes.OpenDictEntry(&entry);
  entry.AppendString("application");
  entry.AppendString(application);
  attributes.CloseContainer(&entry);
  writer.CloseContainer(&attributes);
  std::unique_ptr<dbus::Response> reply = Call(service, &search);
  std::vector<dbus::ObjectPath> unlocked;
  std::vector<dbus::ObjectPath> locked;
  if (!reply) {
    return unlocked;
  }
  dbus::MessageReader reader(reply.get());
  if (!reader.PopArrayOfObjectPaths(&unlocked) ||
      !reader.PopArrayOfObjectPaths(&locked) || !unlocked.empty() ||
      locked.empty()) {
    return unlocked;
  }
  dbus::MethodCall unlock(kServiceInterface, "Unlock");
  dbus::MessageWriter unlock_writer(&unlock);
  unlock_writer.AppendArrayOfObjectPaths(locked);
  std::unique_ptr<dbus::Response> unlocked_reply = Call(service, &unlock);
  if (!unlocked_reply) {
    return unlocked;
  }
  dbus::MessageReader unlock_reader(unlocked_reply.get());
  unlock_reader.PopArrayOfObjectPaths(&unlocked);
  return unlocked;
}

std::optional<std::string> FirstSecret(dbus::ObjectProxy* service,
                                       const std::vector<dbus::ObjectPath>& items,
                                       const dbus::ObjectPath& session) {
  dbus::MethodCall get(kServiceInterface, "GetSecrets");
  dbus::MessageWriter writer(&get);
  writer.AppendArrayOfObjectPaths(items);
  writer.AppendObjectPath(session);
  std::unique_ptr<dbus::Response> reply = Call(service, &get);
  if (!reply) {
    return std::nullopt;
  }
  dbus::MessageReader reader(reply.get());
  dbus::MessageReader secrets(nullptr);
  if (!reader.PopArray(&secrets)) {
    return std::nullopt;
  }
  while (secrets.HasMoreData()) {
    dbus::MessageReader entry(nullptr);
    dbus::MessageReader secret(nullptr);
    dbus::ObjectPath item;
    dbus::ObjectPath secret_session;
    base::span<const uint8_t> parameters;
    base::span<const uint8_t> value;
    if (!secrets.PopDictEntry(&entry) || !entry.PopObjectPath(&item) ||
        !entry.PopStruct(&secret) || !secret.PopObjectPath(&secret_session) ||
        !secret.PopArrayOfBytes(&parameters) ||
        !secret.PopArrayOfBytes(&value)) {
      return std::nullopt;
    }
    if (!value.empty()) {
      return std::string(value.begin(), value.end());
    }
  }
  return std::nullopt;
}

}

std::optional<std::string> ElectronKeyringPassword(
    const std::vector<std::string>& applications) {
  dbus::Bus::Options options;
  options.bus_type = dbus::Bus::SESSION;
  options.connection_type = dbus::Bus::PRIVATE;
  auto bus = base::MakeRefCounted<dbus::Bus>(std::move(options));
  std::optional<std::string> password;
  dbus::ObjectProxy* service = bus->GetObjectProxy(
      kSecretsService, dbus::ObjectPath(kSecretsPath));
  if (std::optional<dbus::ObjectPath> session = OpenPlainSession(service)) {
    for (const std::string& application : applications) {
      std::vector<dbus::ObjectPath> items = UnlockedItems(service, application);
      if (items.empty()) {
        continue;
      }
      password = FirstSecret(service, items, *session);
      if (password) {
        break;
      }
    }
  }
  bus->ShutdownAndBlock();
  return password;
}

}
