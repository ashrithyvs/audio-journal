package com.audiojournal.vault

/** JNI surface of libaj_argon2 (android/vault-crypto, reference libargon2 20190702). */
object Argon2Native {
  init {
    System.loadLibrary("aj_argon2")
  }

  /** Raw Argon2id v0x13; throws IllegalStateException("ARGON2_MEMORY") on allocation failure. */
  @JvmStatic
  external fun argon2id(
      password: ByteArray,
      salt: ByteArray,
      iterations: Int,
      memoryKiB: Int,
      parallelism: Int,
      outLength: Int,
  ): ByteArray
}

/** The production PIN KDF: Argon2id with the record's parameters, 32-byte KEK. */
class Argon2idKdf : PinKdf {
  override fun derive(pin: ByteArray, salt: ByteArray, params: KdfParams): ByteArray =
      Argon2Native.argon2id(pin, salt, params.iterations, params.memoryKiB, params.parallelism, 32)
}
