#include <hermes/hermes.h>
#include <jni.h>
#include <jsi/jsi.h>

#include <string>

namespace {

facebook::hermes::IHermesRootAPI *hermesRoot() {
  return facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
}

}

extern "C" JNIEXPORT jboolean JNICALL Java_com_ardia_phone_JsProfiler_nativeStart(JNIEnv *, jclass, jdouble hz) {
  auto *root = hermesRoot();
  if (root == nullptr) return JNI_FALSE;
  root->enableSamplingProfiler(hz);
  return JNI_TRUE;
}

extern "C" JNIEXPORT jboolean JNICALL Java_com_ardia_phone_JsProfiler_nativeStop(JNIEnv *env, jclass, jstring path) {
  auto *root = hermesRoot();
  if (root == nullptr) return JNI_FALSE;
  root->disableSamplingProfiler();
  const char *chars = env->GetStringUTFChars(path, nullptr);
  std::string file(chars);
  env->ReleaseStringUTFChars(path, chars);
  root->dumpSampledTraceToFile(file);
  return JNI_TRUE;
}
