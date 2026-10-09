cmake_minimum_required(VERSION 3.22)
project(aj_whisper LANGUAGES C CXX)

include(FetchContent)
# whisper.cpp v1.9.5 (commit d1be6fde), pinned by archive SHA-256 (ADR-016).
FetchContent_Declare(
  whisper
  URL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz
  URL_HASH SHA256=ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(whisper)

add_library(aj_whisper SHARED aj_whisper.cpp)
target_link_libraries(aj_whisper PRIVATE whisper log)
target_compile_features(aj_whisper PRIVATE cxx_std_17)
