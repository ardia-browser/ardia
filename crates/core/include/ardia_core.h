#pragma once

#include <stddef.h>
#include <stdint.h>

#define ARDIA_ABI_VERSION 1

#define ARDIA_ENTROPY_BYTES 32

#define ARDIA_MAX_PAYLOAD_BYTES ((1024 * 1024) * 1024)

#define ARDIA_MAX_SEALED_FILE_BYTES (ARDIA_MAX_PAYLOAD_BYTES + 4096)

#define ARDIA_MAX_LABEL_BYTES (64 * 1024)

#define ARDIA_MAX_PASSWORD_FIELD_BYTES ARDIA_MAX_PAYLOAD_BYTES

#define ARDIA_MAX_SEALED_PASSWORD_BYTES (ARDIA_MAX_PAYLOAD_BYTES + (ARDIA_MAX_PAYLOAD_BYTES / 2))

#define ARDIA_MAX_PHRASE_BYTES 4096

#define ARDIA_MAX_LISTING_JSON_BYTES ((16 * 1024) * 1024)

typedef enum ardia_status {
  ARDIA_STATUS_OK = 0,
  ARDIA_STATUS_INVALID_ARGUMENT = 1,
  ARDIA_STATUS_TOO_LARGE = 2,
  ARDIA_STATUS_FORMAT = 3,
  ARDIA_STATUS_AUTHENTICATION = 4,
  ARDIA_STATUS_PHRASE = 5,
  ARDIA_STATUS_RANDOM = 6,
  ARDIA_STATUS_OUTPUT_IN_USE = 7,
} ardia_status;

typedef struct ardia_sync_keys ardia_sync_keys;

typedef struct ardia_buf {
  uint8_t *ptr;
  size_t len;
} ardia_buf;

#ifdef __cplusplus
extern "C" {
#endif

uint32_t ardia_abi_version(void);

void ardia_buf_free(struct ardia_buf *buf);

enum ardia_status ardia_sync_keys_new(const uint8_t *entropy,
                                      size_t entropy_len,
                                      struct ardia_sync_keys **out);

void ardia_sync_keys_free(struct ardia_sync_keys *keys);

enum ardia_status ardia_sync_chain_tag(const struct ardia_sync_keys *keys, struct ardia_buf *out);

enum ardia_status ardia_sync_scope_tag(const struct ardia_sync_keys *keys,
                                       const uint8_t *scope,
                                       size_t scope_len,
                                       struct ardia_buf *out);

enum ardia_status ardia_sync_seal(const struct ardia_sync_keys *keys,
                                  const uint8_t *payload,
                                  size_t payload_len,
                                  const uint8_t *scope_tag,
                                  size_t scope_tag_len,
                                  const uint8_t *file_id,
                                  size_t file_id_len,
                                  struct ardia_buf *out);

enum ardia_status ardia_sync_open(const struct ardia_sync_keys *keys,
                                  const uint8_t *file,
                                  size_t file_len,
                                  const uint8_t *scope_tag,
                                  size_t scope_tag_len,
                                  const uint8_t *file_id,
                                  size_t file_id_len,
                                  struct ardia_buf *out);

enum ardia_status ardia_sync_seal_password(const struct ardia_sync_keys *keys,
                                           const uint8_t *password,
                                           size_t password_len,
                                           const uint8_t *origin,
                                           size_t origin_len,
                                           const uint8_t *username,
                                           size_t username_len,
                                           struct ardia_buf *out);

enum ardia_status ardia_sync_open_password(const struct ardia_sync_keys *keys,
                                           const uint8_t *sealed,
                                           size_t sealed_len,
                                           const uint8_t *origin,
                                           size_t origin_len,
                                           const uint8_t *username,
                                           size_t username_len,
                                           struct ardia_buf *out);

enum ardia_status ardia_sync_new_file_id(struct ardia_buf *out);

enum ardia_status ardia_phrase_generate_entropy(struct ardia_buf *out);

enum ardia_status ardia_phrase_from_entropy(const uint8_t *entropy,
                                            size_t entropy_len,
                                            struct ardia_buf *out);

enum ardia_status ardia_phrase_to_entropy(const uint8_t *text,
                                          size_t text_len,
                                          struct ardia_buf *out);

enum ardia_status ardia_vault_list(const uint8_t *request,
                                   size_t request_len,
                                   struct ardia_buf *out);

#ifdef __cplusplus
}
#endif
