-keep class com.facebook.react.turbomodule.** { *; }
-keep class com.ardia.** { *; }
-keep class expo.modules.** { *; }
-keep class com.swmansion.** { *; }
-keep class com.th3rdwave.safeareacontext.** { *; }
-keep class com.horcrux.svg.** { *; }
-keep class kotlin.Metadata { *; }
-keepnames class * extends android.view.View
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Exceptions,AnnotationDefault,RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations
-keep class * extends androidx.room.RoomDatabase {
    <init>();
}
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
-keep class * extends androidx.glance.appwidget.GlanceAppWidgetReceiver { *; }
-keep class * extends androidx.glance.appwidget.GlanceAppWidget { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
-keep class * implements com.google.firebase.components.ComponentRegistrar {
    public <init>();
}
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
