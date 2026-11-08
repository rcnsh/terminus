import SwiftUI
import WidgetKit

@main
struct TerminusWatchWidgets: WidgetBundle {
    var body: some Widget {
        EmptyWidget()
    }
}

struct EmptyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "next", provider: P()) { _ in Text(verbatim: "t") }
    }
    struct P: TimelineProvider {
        struct E: TimelineEntry { var date: Date }
        func placeholder(in context: Context) -> E { E(date: Date()) }
        func getSnapshot(in context: Context, completion: @escaping @Sendable (E) -> Void) { completion(E(date: Date())) }
        func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<E>) -> Void) {
            completion(Timeline(entries: [E(date: Date())], policy: .never))
        }
    }
}
