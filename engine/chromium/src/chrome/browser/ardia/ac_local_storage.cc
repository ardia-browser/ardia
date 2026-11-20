// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/barrier_closure.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/profiles/profile.h"
#include "components/services/storage/public/mojom/local_storage_control.mojom.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "third_party/blink/public/common/storage_key/storage_key.h"
#include "third_party/blink/public/mojom/dom_storage/storage_area.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia {
namespace {

constexpr size_t kMaxStorageArgsBytes = 8 * 1024 * 1024;
constexpr size_t kMaxStorageBytes = 2'000'000;
constexpr size_t kMaxStorageWrites = 4000;
constexpr uint8_t kUtf16Format = 0;
constexpr uint8_t kLatin1Format = 1;

std::optional<std::u16string> Decode(const std::vector<uint8_t>& bytes) {
  if (bytes.empty()) {
    return std::u16string();
  }
  if (bytes[0] == kLatin1Format) {
    return std::u16string(bytes.begin() + 1, bytes.end());
  }
  if (bytes[0] != kUtf16Format || (bytes.size() - 1) % 2) {
    return std::nullopt;
  }
  std::u16string text((bytes.size() - 1) / 2, u'\0');
  for (size_t i = 0; i < text.size(); ++i) {
    text[i] = static_cast<char16_t>(bytes[1 + 2 * i] | (bytes[2 + 2 * i] << 8));
  }
  return text;
}

bool OnlyLatin1(const std::u16string& text) {
  return std::ranges::all_of(text, [](char16_t c) { return c <= 0xff; });
}

std::vector<uint8_t> EncodeAs(const std::u16string& text, uint8_t format) {
  std::vector<uint8_t> bytes;
  bytes.reserve(1 + text.size() * (format == kLatin1Format ? 1 : 2));
  bytes.push_back(format);
  for (char16_t c : text) {
    bytes.push_back(static_cast<uint8_t>(c & 0xff));
    if (format == kUtf16Format) {
      bytes.push_back(static_cast<uint8_t>(c >> 8));
    }
  }
  return bytes;
}

std::vector<uint8_t> Encode(const std::u16string& text) {
  return EncodeAs(text, OnlyLatin1(text) ? kLatin1Format : kUtf16Format);
}

std::optional<std::vector<uint8_t>> StrayUtf16Form(const std::u16string& text) {
  if (!OnlyLatin1(text)) {
    return std::nullopt;
  }
  return EncodeAs(text, kUtf16Format);
}

bool WellFormed(const std::u16string& text) {
  for (size_t i = 0; i < text.size(); ++i) {
    const char16_t c = text[i];
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= text.size() || text[i + 1] < 0xdc00 || text[i + 1] > 0xdfff) {
        return false;
      }
      ++i;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

std::optional<blink::StorageKey> KeyFor(const std::string& text) {
  const GURL url(text);
  if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS()) {
    return std::nullopt;
  }
  return blink::StorageKey::CreateFirstParty(url::Origin::Create(url));
}

mojo::Remote<blink::mojom::StorageArea> AreaFor(Profile* profile,
                                                const blink::StorageKey& key) {
  mojo::Remote<blink::mojom::StorageArea> area;
  profile->GetDefaultStoragePartition()->GetLocalStorageControl()->BindStorageArea(
      key, area.BindNewPipeAndPassReceiver());
  return area;
}

void SendItems(mojo::Remote<blink::mojom::StorageArea>,
               Reply reply,
               std::vector<blink::mojom::KeyValuePtr> data) {
  base::ListValue items;
  size_t bytes = 0;
  for (const blink::mojom::KeyValuePtr& entry : data) {
    std::optional<std::u16string> key = Decode(entry->key);
    std::optional<std::u16string> value = Decode(entry->value);
    if (!key || !value || !WellFormed(*key) || !WellFormed(*value)) {
      return reply.Send(base::DictValue().Set("items", base::Value()));
    }
    bytes += key->size() + value->size();
    if (bytes > kMaxStorageBytes) {
      return reply.Send(base::DictValue().Set("items", base::Value()));
    }
    items.Append(base::ListValue()
                     .Append(base::UTF16ToUTF8(*key))
                     .Append(base::UTF16ToUTF8(*value)));
  }
  reply.Send(base::DictValue().Set("items", std::move(items)));
}

}
}

AC_PROFILE_CALL(ac_local_storage_read, ardia::Sensitive{ardia::kMaxStorageArgsBytes}) {
  std::optional<blink::StorageKey> key = ardia::KeyFor(call.String("origin"));
  if (!key) {
    return call.TakeReply().Error("origin must be an http or https origin");
  }
  mojo::Remote<blink::mojom::StorageArea> area = ardia::AreaFor(call.profile(), *key);
  blink::mojom::StorageArea* raw = area.get();
  raw->GetAll(mojo::NullRemote(),
              base::BindOnce(&ardia::SendItems, std::move(area), call.TakeReply()));
}

AC_PROFILE_CALL(ac_local_storage_write, ardia::Sensitive{ardia::kMaxStorageArgsBytes}) {
  std::optional<blink::StorageKey> key = ardia::KeyFor(call.String("origin"));
  if (!key) {
    return call.TakeReply().Error("origin must be an http or https origin");
  }
  const base::ListValue* set = call.args().FindList("set");
  const base::ListValue* remove = call.args().FindList("remove");
  if ((set ? set->size() : 0) + (remove ? remove->size() : 0) > ardia::kMaxStorageWrites) {
    return call.TakeReply().Error("too many writes in one call");
  }
  struct Change {
    std::u16string key;
    std::optional<std::u16string> value;
  };
  std::vector<Change> changes;
  if (set) {
    for (const base::Value& pair : *set) {
      const base::ListValue* entry = pair.GetIfList();
      if (entry && entry->size() == 2 && (*entry)[0].is_string() && (*entry)[1].is_string()) {
        changes.push_back({base::UTF8ToUTF16((*entry)[0].GetString()),
                           base::UTF8ToUTF16((*entry)[1].GetString())});
      }
    }
  }
  if (remove) {
    for (const base::Value& name : *remove) {
      if (name.is_string()) {
        changes.push_back({base::UTF8ToUTF16(name.GetString()), std::nullopt});
      }
    }
  }
  size_t operations = 0;
  for (const Change& change : changes) {
    operations += ardia::StrayUtf16Form(change.key) ? 2 : 1;
  }
  auto area = base::MakeRefCounted<base::RefCountedData<mojo::Remote<blink::mojom::StorageArea>>>(
      ardia::AreaFor(call.profile(), *key));
  auto written = base::MakeRefCounted<base::RefCountedData<int>>(0);
  base::RepeatingClosure done = base::BarrierClosure(
      operations, base::BindOnce(
                      [](scoped_refptr<base::RefCountedData<mojo::Remote<blink::mojom::StorageArea>>>,
                         scoped_refptr<base::RefCountedData<int>> written, ardia::Reply reply) {
                        reply.Send(base::DictValue().Set("written", written->data));
                      },
                      area, written, call.TakeReply()));
  auto put = [](scoped_refptr<base::RefCountedData<int>> written, base::RepeatingClosure done,
                bool success) {
    if (success) {
      ++written->data;
    }
    done.Run();
  };
  auto deleted = [](scoped_refptr<base::RefCountedData<int>> written, base::RepeatingClosure done) {
    ++written->data;
    done.Run();
  };
  for (const Change& change : changes) {
    if (std::optional<std::vector<uint8_t>> stray = ardia::StrayUtf16Form(change.key)) {
      area->data->Delete(*stray, std::nullopt, nullptr, done);
    }
    if (change.value) {
      area->data->Put(ardia::Encode(change.key), ardia::Encode(*change.value), std::nullopt, nullptr,
                      base::BindOnce(put, written, done));
    } else {
      area->data->Delete(ardia::Encode(change.key), std::nullopt, nullptr,
                         base::BindOnce(deleted, written, done));
    }
  }
}
