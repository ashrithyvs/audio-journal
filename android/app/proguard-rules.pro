# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# App-owned transcription JNI (ADR-016): natives and the callback are bound by name.
-keepclasseswithmembernames,includedescriptorclasses class com.audiojournal.speech.WhisperNative {
    native <methods>;
}
-keep class com.audiojournal.speech.WhisperNative { *; }
-keep interface com.audiojournal.speech.SegmentListener { *; }
-keep class * implements com.audiojournal.speech.SegmentListener { void onSegment(...); }

# SQLCipher (ADR-017): JNI binds Java classes and methods by name.
-keep,includedescriptorclasses class net.zetetic.database.** { *; }
-keep,includedescriptorclasses interface net.zetetic.database.** { *; }
# Vault JNI (libaj_argon2).
-keepclasseswithmembernames class com.audiojournal.vault.Argon2Native {
    native <methods>;
}
