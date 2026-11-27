#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ardia_import.h"

static int read_file(const char *dir, const char *name, ardia_import_bytes *out, uint8_t **owned) {
  char path[4096];
  FILE *file;
  long size;
  if (snprintf(path, sizeof path, "%s/%s", dir, name) >= (int)sizeof path) return -1;
  file = fopen(path, "rb");
  if (file == NULL) return 0;
  if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return -1;
  }
  *owned = malloc((size_t)size + 1);
  if (*owned == NULL || fread(*owned, 1, (size_t)size, file) != (size_t)size) {
    fclose(file);
    return -1;
  }
  fclose(file);
  out->ptr = *owned;
  out->len = (size_t)size;
  return 1;
}

int main(int argc, char **argv) {
  ardia_import_bytes local, account;
  uint8_t *local_bytes = NULL, *account_bytes = NULL;
  ardia_import_buf result;
  ardia_import_status status;
  int has_local, has_account;
  if (argc != 2) return 2;
  has_local = read_file(argv[1], "Bookmarks", &local, &local_bytes);
  has_account = read_file(argv[1], "AccountBookmarks", &account, &account_bytes);
  if (has_local < 0 || has_account < 0) return 3;
  status = ardia_import_chromium_bookmarks(has_local ? &local : NULL, has_account ? &account : NULL, &result);
  if (status == ARDIA_IMPORT_STATUS_OK) {
    fputs("{\"ok\":", stdout);
    fwrite(result.ptr, 1, result.len, stdout);
    fputs("}", stdout);
  } else {
    fputs("{\"error\":", stdout);
    fwrite(result.ptr, 1, result.len, stdout);
    fputs("}", stdout);
  }
  ardia_import_buf_free(&result);
  free(local_bytes);
  free(account_bytes);
  return 0;
}
