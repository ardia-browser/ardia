#pragma once

#include <stddef.h>
#include <stdint.h>

#define ARDIA_UPDATE_ABI_VERSION 1

#define ARDIA_UPDATE_MAX_MANIFEST_BYTES 4096

#define ARDIA_UPDATE_SIGNATURE_BYTES 64

#define ARDIA_UPDATE_PUBLIC_KEY_BYTES 32

#define ARDIA_UPDATE_SHA256_BYTES 32

#define ARDIA_UPDATE_MAX_VERSION_BYTES 64

#define ARDIA_UPDATE_MAX_PACKAGE_BYTES 536870912

#define ARDIA_UPDATE_KIND_DEB 0

#define ARDIA_UPDATE_KIND_TARBALL 1

#define ARDIA_UPDATE_KIND_APPIMAGE 2

#define ARDIA_UPDATE_CHANNEL_STABLE 0

#define ARDIA_UPDATE_CHANNEL_NIGHTLY 1

typedef enum ardia_update_status {
  ARDIA_UPDATE_STATUS_OK = 0,
  ARDIA_UPDATE_STATUS_INVALID_ARGUMENT = 1,
  ARDIA_UPDATE_STATUS_TOO_LARGE = 2,
  ARDIA_UPDATE_STATUS_MANIFEST = 3,
  ARDIA_UPDATE_STATUS_SIGNATURE = 4,
  ARDIA_UPDATE_STATUS_NOT_NEWER = 5,
  ARDIA_UPDATE_STATUS_KIND = 6,
  ARDIA_UPDATE_STATUS_VERSION = 7,
  ARDIA_UPDATE_STATUS_CHANNEL = 8,
} ardia_update_status;

typedef struct ardia_update_package {
  uint64_t size;
  uint8_t sha256[ARDIA_UPDATE_SHA256_BYTES];
} ardia_update_package;

#ifdef __cplusplus
extern "C" {
#endif

uint32_t ardia_update_abi_version(void);

enum ardia_update_status ardia_update_verify_linux(const uint8_t *manifest,
                                                   size_t manifest_len,
                                                   const uint8_t *signature,
                                                   size_t signature_len,
                                                   const uint8_t *public_key,
                                                   size_t public_key_len,
                                                   const uint8_t *version,
                                                   size_t version_len,
                                                   const uint8_t *installed,
                                                   size_t installed_len,
                                                   uint32_t kind,
                                                   struct ardia_update_package *out);

enum ardia_update_status ardia_update_compare_versions(const uint8_t *left,
                                                       size_t left_len,
                                                       const uint8_t *right,
                                                       size_t right_len,
                                                       int32_t *out);

enum ardia_update_status ardia_update_channel_of(const uint8_t *version,
                                                 size_t version_len,
                                                 uint32_t *out);

enum ardia_update_status ardia_update_check_offer(const uint8_t *candidate,
                                                  size_t candidate_len,
                                                  const uint8_t *installed,
                                                  size_t installed_len,
                                                  uint32_t channel);

#ifdef __cplusplus
}
#endif
