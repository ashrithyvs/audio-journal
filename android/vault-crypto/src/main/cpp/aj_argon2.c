// JNI bridge to the reference libargon2 (ADR-017): raw Argon2id for the vault
// PIN KEK and the AJB1 KEK. The password copy and the output are wiped; nothing
// is logged. Failures throw IllegalStateException with a code only.
#include <jni.h>
#include <stdint.h>

#include "argon2.h"

static void wipe(void *buffer, size_t length) {
  volatile unsigned char *bytes = buffer;
  while (length--) {
    *bytes++ = 0;
  }
}

static void fail(JNIEnv *env, const char *code) {
  jclass type = (*env)->FindClass(env, "java/lang/IllegalStateException");
  if (type != NULL) {
    (*env)->ThrowNew(env, type, code);
  }
}

JNIEXPORT jbyteArray JNICALL Java_com_audiojournal_vault_Argon2Native_argon2id(
    JNIEnv *env, jclass type, jbyteArray password, jbyteArray salt, jint iterations,
    jint memoryKiB, jint parallelism, jint outLength) {
  (void)type;
  if (outLength < 16 || outLength > 64 || iterations < 1 || memoryKiB < 8 ||
      parallelism < 1) {
    fail(env, "ARGON2_PARAMS");
    return NULL;
  }
  const jsize passwordLength = (*env)->GetArrayLength(env, password);
  const jsize saltLength = (*env)->GetArrayLength(env, salt);
  jbyte *passwordBytes = (*env)->GetByteArrayElements(env, password, NULL);
  jbyte *saltBytes = (*env)->GetByteArrayElements(env, salt, NULL);
  if (passwordBytes == NULL || saltBytes == NULL) {
    if (passwordBytes != NULL) (*env)->ReleaseByteArrayElements(env, password, passwordBytes, JNI_ABORT);
    if (saltBytes != NULL) (*env)->ReleaseByteArrayElements(env, salt, saltBytes, JNI_ABORT);
    fail(env, "ARGON2_MEMORY");
    return NULL;
  }
  uint8_t out[64];
  const int result = argon2id_hash_raw(
      (uint32_t)iterations, (uint32_t)memoryKiB, (uint32_t)parallelism, passwordBytes,
      (size_t)passwordLength, saltBytes, (size_t)saltLength, out, (size_t)outLength);
  wipe(passwordBytes, (size_t)passwordLength);
  (*env)->ReleaseByteArrayElements(env, password, passwordBytes, JNI_ABORT);
  (*env)->ReleaseByteArrayElements(env, salt, saltBytes, JNI_ABORT);
  if (result != ARGON2_OK) {
    wipe(out, sizeof out);
    fail(env, result == ARGON2_MEMORY_ALLOCATION_ERROR ? "ARGON2_MEMORY" : "ARGON2_FAILED");
    return NULL;
  }
  jbyteArray tag = (*env)->NewByteArray(env, outLength);
  if (tag != NULL) {
    (*env)->SetByteArrayRegion(env, tag, 0, outLength, (const jbyte *)out);
  }
  wipe(out, sizeof out);
  return tag;
}
