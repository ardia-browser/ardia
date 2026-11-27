#include <stdio.h>
#include <stdlib.h>

#include "ardia_import.h"

int main(int argc, char **argv) {
  FILE *file;
  long size;
  uint8_t *bytes;
  ardia_import_bytes html;
  ardia_import_buf result;
  ardia_import_status status;
  if (argc != 2) return 2;
  file = fopen(argv[1], "rb");
  if (file == NULL) return 3;
  if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return 3;
  }
  bytes = malloc((size_t)size + 1);
  if (bytes == NULL || fread(bytes, 1, (size_t)size, file) != (size_t)size) {
    fclose(file);
    free(bytes);
    return 3;
  }
  fclose(file);
  html.ptr = bytes;
  html.len = (size_t)size;
  status = ardia_import_netscape_bookmarks(&html, &result);
  fputs(status == ARDIA_IMPORT_STATUS_OK ? "{\"ok\":" : "{\"error\":", stdout);
  fwrite(result.ptr, 1, result.len, stdout);
  fputs("}", stdout);
  ardia_import_buf_free(&result);
  free(bytes);
  return 0;
}
