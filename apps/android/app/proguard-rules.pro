# Glance creates a widget's ActionCallback by its class name when the button
# is tapped (actionRunCallback<T>), so nothing in the code constructs one and
# R8 drops the constructor: the tap then silently does nothing. That's what
# broke the widget's Timetable button in 2.0.0-beta.8.
-keep class * implements androidx.glance.appwidget.action.ActionCallback {
    <init>();
}
