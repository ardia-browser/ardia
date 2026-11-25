#pragma once

#include <stddef.h>
#include <stdint.h>

#define ARDIA_IMPORT_ABI_VERSION 1

#define ARDIA_IMPORT_MAX_INPUT_BYTES ((64 * 1024) * 1024)

typedef enum ardia_import_status {
  ARDIA_IMPORT_STATUS_OK = 0,
  ARDIA_IMPORT_STATUS_INVALID_ARGUMENT = 1,
  ARDIA_IMPORT_STATUS_TOO_LARGE = 2,
  ARDIA_IMPORT_STATUS_NOT_FOUND = 3,
  ARDIA_IMPORT_STATUS_UNREADABLE = 4,
} ardia_import_status;

typedef struct ardia_import_bytes {
  const uint8_t *ptr;
  size_t len;
} ardia_import_bytes;

typedef struct ardia_import_buf {
  uint8_t *ptr;
  size_t len;
} ardia_import_buf;

#ifdef __cplusplus
extern "C" {
#endif

uint32_t ardia_import_abi_version(void);

enum ardia_import_status ardia_import_chromium_bookmarks(const struct ardia_import_bytes *bookmarks,
                                                         const struct ardia_import_bytes *account_bookmarks,
                                                         struct ardia_import_buf *out);

enum ardia_import_status ardia_import_netscape_bookmarks(const struct ardia_import_bytes *html,
                                                         struct ardia_import_buf *out);

void ardia_import_buf_free(struct ardia_import_buf *buf);

#ifdef __cplusplus
}
#endif
