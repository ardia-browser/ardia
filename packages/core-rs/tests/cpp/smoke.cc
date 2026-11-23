#include "ardia_core.h"

#include <cstdio>
#include <cstring>
#include <string>

namespace {

class Buffer {
 public:
  Buffer() = default;
  Buffer(const Buffer&) = delete;
  Buffer& operator=(const Buffer&) = delete;
  ~Buffer() { ardia_buf_free(&buf_); }

  ardia_buf* out() { return &buf_; }
  std::string text() const { return std::string(reinterpret_cast<const char*>(buf_.ptr), buf_.len); }

 private:
  ardia_buf buf_{nullptr, 0};
};

int Fail(const char* what) {
  std::fprintf(stderr, "ardia_core C++ smoke failed: %s\n", what);
  return 1;
}

}

int main() {
  const std::string phrase =
      "awful supreme heart leopard seminar age lizard hand aware health coral muscle glance save uphold orient carbon "
      "people leopard outside describe neither health symbol";
  Buffer entropy;
  if (ardia_phrase_to_entropy(reinterpret_cast<const uint8_t*>(phrase.data()), phrase.size(), entropy.out()) !=
      ARDIA_STATUS_OK)
    return Fail("phrase");
  ardia_sync_keys* keys = nullptr;
  ardia_buf raw{};
  if (ardia_sync_keys_new(nullptr, 0, &keys) != ARDIA_STATUS_INVALID_ARGUMENT) return Fail("bad entropy");
  Buffer copy;
  if (ardia_phrase_from_entropy(nullptr, 0, copy.out()) != ARDIA_STATUS_INVALID_ARGUMENT) return Fail("empty entropy");
  Buffer again;
  if (ardia_phrase_to_entropy(reinterpret_cast<const uint8_t*>(phrase.data()), phrase.size(), again.out()) !=
          ARDIA_STATUS_OK ||
      again.text() != entropy.text())
    return Fail("phrase again");
  const std::string bytes = entropy.text();
  if (ardia_sync_keys_new(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), &keys) != ARDIA_STATUS_OK)
    return Fail("keys");
  Buffer chain;
  int status = 0;
  if (ardia_sync_chain_tag(keys, chain.out()) != ARDIA_STATUS_OK || chain.text() != "h2zf35mqk7uz4achercqnm7zbm")
    status = Fail("chain tag");
  if (ardia_sync_chain_tag(keys, chain.out()) != ARDIA_STATUS_OUTPUT_IN_USE) status = Fail("occupied slot");
  const std::string password = "hunter2 é😀", origin = "https://bank.example", username = "luke";
  Buffer sealed;
  if (ardia_sync_seal_password(keys, reinterpret_cast<const uint8_t*>(password.data()), password.size(),
                               reinterpret_cast<const uint8_t*>(origin.data()), origin.size(),
                               reinterpret_cast<const uint8_t*>(username.data()), username.size(),
                               sealed.out()) != ARDIA_STATUS_OK ||
      sealed.text() != "AcrrIDM5nPs4BkGJEVDKU2CsGtA234mRaskXUkyZPWLEn4dCoLqdAGNektybOCWXgD8SCgYVXTg7BD1iAg==")
    status = Fail("seal password");
  ardia_buf_free(&raw);
  ardia_sync_keys_free(keys);
  if (status == 0) std::printf("ardia_core C++ smoke passed\n");
  return status;
}
