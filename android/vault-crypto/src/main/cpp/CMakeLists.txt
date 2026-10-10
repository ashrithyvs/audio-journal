cmake_minimum_required(VERSION 3.22)
project(aj_argon2 LANGUAGES C)

include(FetchContent)
# P-H-C reference Argon2, release 20190702 (commit 62358ba2), pinned by the
# archive's full SHA-256 (ADR-017). CC0 / Apache-2.0.
FetchContent_Declare(
  argon2
  URL https://github.com/P-H-C/phc-winner-argon2/archive/refs/tags/20190702.tar.gz
  URL_HASH SHA256=daf972a89577f8772602bf2eb38b6a3dd3d922bf5724d45e7f9589b5e830442c
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
# The archive has no CMakeLists.txt, so this only downloads and verifies it.
FetchContent_MakeAvailable(argon2)

# The portable reference core (ref.c) on every ABI, so output never depends
# on CPU features. Threads serve p > 1.
add_library(aj_argon2 SHARED
  aj_argon2.c
  ${argon2_SOURCE_DIR}/src/argon2.c
  ${argon2_SOURCE_DIR}/src/core.c
  ${argon2_SOURCE_DIR}/src/encoding.c
  ${argon2_SOURCE_DIR}/src/ref.c
  ${argon2_SOURCE_DIR}/src/thread.c
  ${argon2_SOURCE_DIR}/src/blake2/blake2b.c
)
target_include_directories(aj_argon2 PRIVATE ${argon2_SOURCE_DIR}/include ${argon2_SOURCE_DIR}/src)
target_compile_options(aj_argon2 PRIVATE -O3 -fvisibility=hidden)
