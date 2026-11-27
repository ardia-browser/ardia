#include <stdio.h>
#include <string.h>

#include "ardia_core.h"

static int fail(const char *what) {
  fprintf(stderr, "ardia_core smoke failed: %s\n", what);
  return 1;
}

static int same(const ardia_buf *buf, const char *text) {
  return buf->len == strlen(text) && memcmp(buf->ptr, text, buf->len) == 0;
}

int main(void) {
  uint8_t entropy[ARDIA_ENTROPY_BYTES] = {0};
  ardia_sync_keys *keys = NULL;
  ardia_buf chain = {0}, scope = {0}, sealed = {0}, opened = {0}, wrong = {0};
  const char *payload = "from C";
  int status = 0;
  if (ardia_abi_version() != ARDIA_ABI_VERSION) return fail("abi version");
  if (ardia_sync_keys_new(entropy, sizeof entropy, &keys) != ARDIA_STATUS_OK) return fail("keys");
  if (ardia_sync_chain_tag(keys, &chain) != ARDIA_STATUS_OK || !same(&chain, "gbcx4r55mk3rlaegbggknyx4ta")) status = fail("chain tag");
  if (ardia_sync_scope_tag(keys, (const uint8_t *)"app", 3, &scope) != ARDIA_STATUS_OK || !same(&scope, "nr4ncp5iyqzqgjn6ol4zksqtne")) status = fail("scope tag");
  if (ardia_sync_seal(keys, (const uint8_t *)payload, strlen(payload), scope.ptr, scope.len, (const uint8_t *)"f1", 2, &sealed) != ARDIA_STATUS_OK || sealed.len != 4 + 12 + 1024 + 16) status = fail("seal");
  if (ardia_sync_open(keys, sealed.ptr, sealed.len, scope.ptr, scope.len, (const uint8_t *)"f1", 2, &opened) != ARDIA_STATUS_OK || !same(&opened, payload)) status = fail("open");
  if (ardia_sync_open(keys, sealed.ptr, sealed.len, scope.ptr, scope.len, (const uint8_t *)"f2", 2, &wrong) != ARDIA_STATUS_AUTHENTICATION || !same(&wrong, "{\"code\":\"authentication\"}")) status = fail("wrong file id");
  ardia_buf_free(&chain);
  ardia_buf_free(&scope);
  ardia_buf_free(&sealed);
  ardia_buf_free(&opened);
  ardia_buf_free(&wrong);
  if (chain.ptr != NULL || chain.len != 0) status = fail("free resets the buffer");
  ardia_sync_keys_free(keys);
  if (status == 0) printf("ardia_core smoke passed\n");
  return status;
}
