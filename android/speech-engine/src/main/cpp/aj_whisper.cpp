// JNI bridge for Audio Journal's on-device transcription (ADR-016).
// One whisper_context (model weights) is shared; every request gets its own
// whisper_state, so concurrent requests do not duplicate the model. Segment
// text goes to the Java callback only; nothing is logged.
#include <jni.h>

#include <atomic>
#include <chrono>
#include <string>

#include "whisper.h"

namespace {

struct Cancel {
  std::atomic<bool> requested{false};
};

struct Callback {
  JNIEnv* env;
  jobject listener;
  jmethodID onSegment;
};

std::string escape(const char* text) {
  std::string out;
  for (const char* p = text; *p; ++p) {
    const unsigned char c = static_cast<unsigned char>(*p);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += static_cast<char>(c);
    } else if (c < 0x20) {
      char buffer[8];
      snprintf(buffer, sizeof buffer, "\\u%04x", c);
      out += buffer;
    } else {
      out += static_cast<char>(c);
    }
  }
  return out;
}

jstring utf8(JNIEnv* env, const std::string& value) {
  // NewStringUTF needs modified UTF-8; pass bytes through a Java String.
  jbyteArray bytes = env->NewByteArray(static_cast<jsize>(value.size()));
  env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(value.size()),
                          reinterpret_cast<const jbyte*>(value.data()));
  jclass stringClass = env->FindClass("java/lang/String");
  jmethodID constructor = env->GetMethodID(stringClass, "<init>", "([BLjava/lang/String;)V");
  jstring result = static_cast<jstring>(
      env->NewObject(stringClass, constructor, bytes, env->NewStringUTF("UTF-8")));
  env->DeleteLocalRef(bytes);
  env->DeleteLocalRef(stringClass);
  return result;
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL Java_com_audiojournal_speech_WhisperNative_loadModel(
    JNIEnv* env, jclass, jstring path) {
  const char* model = env->GetStringUTFChars(path, nullptr);
  // Library defaults (as whisper-cli): flash attention on; CPU-only build.
  whisper_context_params params = whisper_context_default_params();
  whisper_context* context = whisper_init_from_file_with_params_no_state(model, params);
  env->ReleaseStringUTFChars(path, model);
  return reinterpret_cast<jlong>(context);
}

JNIEXPORT void JNICALL Java_com_audiojournal_speech_WhisperNative_freeModel(JNIEnv*, jclass,
                                                                           jlong handle) {
  whisper_free(reinterpret_cast<whisper_context*>(handle));
}

// Decoder states are pooled by the caller: allocating one per request costs
// hundreds of MB of compute buffers and caused memory pressure on device.
JNIEXPORT jlong JNICALL Java_com_audiojournal_speech_WhisperNative_newState(JNIEnv*, jclass,
                                                                           jlong model) {
  return reinterpret_cast<jlong>(whisper_init_state(reinterpret_cast<whisper_context*>(model)));
}

JNIEXPORT void JNICALL Java_com_audiojournal_speech_WhisperNative_freeState(JNIEnv*, jclass,
                                                                           jlong state) {
  whisper_free_state(reinterpret_cast<whisper_state*>(state));
}

JNIEXPORT jlong JNICALL Java_com_audiojournal_speech_WhisperNative_newCancel(JNIEnv*, jclass) {
  return reinterpret_cast<jlong>(new Cancel());
}

JNIEXPORT void JNICALL Java_com_audiojournal_speech_WhisperNative_cancel(JNIEnv*, jclass,
                                                                        jlong handle) {
  reinterpret_cast<Cancel*>(handle)->requested.store(true);
}

JNIEXPORT void JNICALL Java_com_audiojournal_speech_WhisperNative_freeCancel(JNIEnv*, jclass,
                                                                            jlong handle) {
  delete reinterpret_cast<Cancel*>(handle);
}

JNIEXPORT jstring JNICALL Java_com_audiojournal_speech_WhisperNative_systemInfo(JNIEnv* env,
                                                                               jclass) {
  return utf8(env, whisper_print_system_info());
}

// Returns JSON: {"status":"ok"|"cancelled"|"failed","segments":[...],"timings":{...}}
JNIEXPORT jstring JNICALL Java_com_audiojournal_speech_WhisperNative_transcribe(
    JNIEnv* env, jclass, jlong modelHandle, jlong stateHandle, jfloatArray pcm, jint threads,
    jlong cancelHandle, jobject listener) {
  auto* context = reinterpret_cast<whisper_context*>(modelHandle);
  auto* state = reinterpret_cast<whisper_state*>(stateHandle);
  auto* cancel = reinterpret_cast<Cancel*>(cancelHandle);
  const auto started = std::chrono::steady_clock::now();
  if (state == nullptr) return utf8(env, R"({"status":"failed","reason":"state"})");

  jclass listenerClass = env->GetObjectClass(listener);
  Callback callback{env, listener,
                    env->GetMethodID(listenerClass, "onSegment", "(JJLjava/lang/String;)V")};

  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  // The library default runs best_of = 5 greedy decoders on every request
  // (whisper.cpp v1.9.5), five times the decode work for identical text. One
  // decoder matches the evaluated configuration (whisper-cli -bs 1 -bo 1).
  params.greedy.best_of = 1;
  params.n_threads = threads;
  params.language = "en";
  params.translate = false;
  params.print_progress = false;
  params.print_realtime = false;
  params.print_special = false;
  params.print_timestamps = false;
  params.no_context = true;
  params.abort_callback = [](void* data) {
    return static_cast<Cancel*>(data)->requested.load();
  };
  params.abort_callback_user_data = cancel;
  params.new_segment_callback = [](whisper_context*, whisper_state* s, int added, void* data) {
    auto* cb = static_cast<Callback*>(data);
    const int total = whisper_full_n_segments_from_state(s);
    for (int index = total - added; index < total; ++index) {
      jstring text = utf8(cb->env, whisper_full_get_segment_text_from_state(s, index));
      cb->env->CallVoidMethod(cb->listener, cb->onSegment,
                              static_cast<jlong>(whisper_full_get_segment_t0_from_state(s, index) * 10),
                              static_cast<jlong>(whisper_full_get_segment_t1_from_state(s, index) * 10),
                              text);
      cb->env->DeleteLocalRef(text);
    }
  };
  params.new_segment_callback_user_data = &callback;

  jsize length = env->GetArrayLength(pcm);
  jfloat* samples = env->GetFloatArrayElements(pcm, nullptr);
  const int result = whisper_full_with_state(context, state, params, samples, length);
  env->ReleaseFloatArrayElements(pcm, samples, JNI_ABORT);

  const double wallMs = std::chrono::duration<double, std::milli>(
                            std::chrono::steady_clock::now() - started)
                            .count();
  std::string json;
  if (cancel->requested.load()) {
    json = R"({"status":"cancelled")";
  } else if (result != 0) {
    json = R"({"status":"failed","reason":"whisper_full )" + std::to_string(result) + "\"";
  } else {
    json = R"({"status":"ok")";
  }
  json += ",\"segments\":[";
  const int segments = whisper_full_n_segments_from_state(state);
  for (int index = 0; index < segments; ++index) {
    if (index) json += ',';
    json += "{\"t0Ms\":" + std::to_string(whisper_full_get_segment_t0_from_state(state, index) * 10) +
            ",\"t1Ms\":" + std::to_string(whisper_full_get_segment_t1_from_state(state, index) * 10) +
            ",\"text\":\"" + escape(whisper_full_get_segment_text_from_state(state, index)) + "\"}";
  }
  json += "],\"timings\":{\"inferenceMs\":" + std::to_string(wallMs) + "}}";
  env->DeleteLocalRef(listenerClass);
  return utf8(env, json);
}

}  // extern "C"
