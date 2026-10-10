/* Host driver over the pinned reference libargon2 (the same source the app
 * builds in android/vault-crypto): reads lines of
 *   <password hex> <salt hex> <t> <m KiB> <p> <tag length>
 * and prints the raw Argon2id tag in hex. Used only to cross-check the
 * independent JS implementation in ../lib/argon2.mjs. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "argon2.h"

static size_t unhex(const char *hex, unsigned char *out, size_t max) {
  size_t length = strlen(hex) / 2;
  if (length > max) exit(2);
  for (size_t i = 0; i < length; i++) sscanf(hex + 2 * i, "%2hhx", &out[i]);
  return length;
}

int main(void) {
  char password_hex[4096], salt_hex[256];
  unsigned t, m, p, tag_length;
  unsigned char password[2048], salt[128], tag[64];
  while (scanf("%4095s %255s %u %u %u %u", password_hex, salt_hex, &t, &m, &p, &tag_length) == 6) {
    size_t password_length = strcmp(password_hex, "-") == 0 ? 0 : unhex(password_hex, password, sizeof password);
    size_t salt_length = unhex(salt_hex, salt, sizeof salt);
    if (tag_length > sizeof tag) return 2;
    int rc = argon2id_hash_raw(t, m, p, password, password_length, salt, salt_length, tag, tag_length);
    if (rc != ARGON2_OK) {
      printf("error %d\n", rc);
      continue;
    }
    for (unsigned i = 0; i < tag_length; i++) printf("%02x", tag[i]);
    printf("\n");
  }
  return 0;
}
