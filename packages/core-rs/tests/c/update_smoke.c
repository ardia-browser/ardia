#include <stdio.h>
#include <string.h>

#include "ardia_update.h"

static const char manifest[] =
    "ardia-linux-update 1\n"
    "version 0.2.48\n"
    "appimage Ardia-0.2.48-linux-x64.AppImage 86a3ea70f1cc738fa332e14d087a25247917fb7d88bef063ca71a29aeeb63b9a 5\n";
static const char signature_hex[] =
    "3c313533c2dd7cbd657228a27d44650e5d1eecc10c928d14682127c7824e97ee"
    "a51d6a60cfd336eddcdde58e4ded039735656b09b8067020bdd2f3ff4cef9104";
static const char key_hex[] = "2012cb90ca60e8e5d8daf66e2272d2233e0486d557e8c66141ed8920177d7eb7";
static const char sha256_hex[] = "86a3ea70f1cc738fa332e14d087a25247917fb7d88bef063ca71a29aeeb63b9a";

static int fail(const char *what) {
  fprintf(stderr, "ardia_update smoke failed: %s\n", what);
  return 1;
}

static void decode(const char *hex, uint8_t *out, size_t len) {
  for (size_t i = 0; i < len; i++) {
    unsigned value = 0;
    sscanf(hex + 2 * i, "%2x", &value);
    out[i] = (uint8_t)value;
  }
}

static ardia_update_status verify(const char *text, const uint8_t *signature, const uint8_t *key, const char *version,
                                  const char *installed, ardia_update_package *out) {
  return ardia_update_verify_linux((const uint8_t *)text, strlen(text), signature, ARDIA_UPDATE_SIGNATURE_BYTES, key,
                                   ARDIA_UPDATE_PUBLIC_KEY_BYTES, (const uint8_t *)version, strlen(version),
                                   (const uint8_t *)installed, strlen(installed), ARDIA_UPDATE_KIND_APPIMAGE, out);
}

int main(void) {
  uint8_t signature[ARDIA_UPDATE_SIGNATURE_BYTES], key[ARDIA_UPDATE_PUBLIC_KEY_BYTES], sha256[ARDIA_UPDATE_SHA256_BYTES];
  ardia_update_package package = {0, {0}};
  char tampered[sizeof manifest];
  int32_t order = 9;
  uint32_t channel = 9;
  int status = 0;
  decode(signature_hex, signature, sizeof signature);
  decode(key_hex, key, sizeof key);
  decode(sha256_hex, sha256, sizeof sha256);
  if (ardia_update_abi_version() != ARDIA_UPDATE_ABI_VERSION) return fail("abi version");
  if (verify(manifest, signature, key, "0.2.48", "0.2.47", &package) != ARDIA_UPDATE_STATUS_OK) status = fail("verify");
  if (package.size != 5 || memcmp(package.sha256, sha256, sizeof sha256) != 0) status = fail("package");
  memcpy(tampered, manifest, sizeof manifest);
  tampered[strlen(tampered) - 2] = '6';
  if (verify(tampered, signature, key, "0.2.48", "0.2.47", &package) != ARDIA_UPDATE_STATUS_SIGNATURE || package.size != 0) status = fail("tampered");
  signature[0] ^= 1;
  if (verify(manifest, signature, key, "0.2.48", "0.2.47", &package) != ARDIA_UPDATE_STATUS_SIGNATURE) status = fail("bad signature");
  signature[0] ^= 1;
  key[0] ^= 1;
  if (verify(manifest, signature, key, "0.2.48", "0.2.47", &package) != ARDIA_UPDATE_STATUS_SIGNATURE) status = fail("wrong key");
  key[0] ^= 1;
  if (verify(manifest, signature, key, "0.2.48", "0.2.48", &package) != ARDIA_UPDATE_STATUS_NOT_NEWER) status = fail("same version");
  if (verify(manifest, signature, key, "0.2.48", "0.2.49-nightly.1", &package) != ARDIA_UPDATE_STATUS_NOT_NEWER) status = fail("downgrade");
  if (ardia_update_compare_versions((const uint8_t *)"0.2.48-nightly.9", 16, (const uint8_t *)"0.2.48", 6, &order) != ARDIA_UPDATE_STATUS_OK || order != -1) status = fail("nightly before stable");
  if (ardia_update_channel_of((const uint8_t *)"0.2.48-nightly.9", 16, &channel) != ARDIA_UPDATE_STATUS_OK || channel != ARDIA_UPDATE_CHANNEL_NIGHTLY) status = fail("channel");
  if (ardia_update_check_offer((const uint8_t *)"0.2.49-nightly.1", 16, (const uint8_t *)"0.2.48", 6, ARDIA_UPDATE_CHANNEL_STABLE) != ARDIA_UPDATE_STATUS_CHANNEL) status = fail("stable channel skips nightlies");
  if (ardia_update_check_offer(NULL, 3, (const uint8_t *)"0.2.48", 6, ARDIA_UPDATE_CHANNEL_STABLE) != ARDIA_UPDATE_STATUS_INVALID_ARGUMENT) status = fail("null input");
  if (status == 0) printf("ardia_update smoke passed\n");
  return status;
}
