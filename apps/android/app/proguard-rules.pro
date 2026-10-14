# Glance creates a widget's ActionCallback by its class name when the button
# is tapped (actionRunCallback<T>), so nothing in the code constructs one and
# R8 drops the constructor: the tap then silently does nothing.
-keep class * implements androidx.glance.appwidget.action.ActionCallback {
    <init>();
}
