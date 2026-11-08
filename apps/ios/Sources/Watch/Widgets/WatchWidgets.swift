import SwiftUI
import WidgetKit

/// The watch's complications, one widget in three families: inline,
/// circular and rectangular, the last also the Smart Stack's.
@main
struct TerminusWatchWidgets: WidgetBundle {
    var body: some Widget {
        NextGlanceWidget()
    }
}

struct NextGlanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "next", provider: GlanceProvider()) { entry in
            GlanceView(entry: entry)
        }
        .configurationDisplayName(L("Next bus"))
        .description(L("The next bus to wherever you're going next"))
        .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular])
    }
}

/// One moment of a complication: the plan as kept, read once.
struct GlanceEntry: TimelineEntry {
    var date: Date
    var paired: Bool
    var plan: NextAnswer?
    var error: String?
    var relevance: TimelineEntryRelevance?

    var glance: Glance { Glance.of(paired: paired, answer: plan, error: error, now: date.addingTimeInterval(ServerClock.skew)) }
}

/// The complications' timeline: a new answer first if the kept one is due
/// (WatchPlan, by the iPhone widget's rules), then an entry for now and for
/// each moment it looks different by itself, and the next reload at the
/// answer's next moment, never sooner than WidgetTiming.minReload.
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry { Self.sample() }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (GlanceEntry) -> Void) {
        let e = Self.entry(at: Date())
        completion(e.plan == nil && context.isPreview ? Self.sample() : e)
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<GlanceEntry>) -> Void) {
        Task {
            await WatchPlan.refreshIfDue()
            completion(Self.timeline())
        }
    }

    static func entry(at date: Date) -> GlanceEntry {
        let paired = TokenStore.read() != nil
        let plan = paired ? WidgetStore.plan()?.0 : nil
        let score = Glance.relevance(paired: paired, answer: plan, now: date.addingTimeInterval(ServerClock.skew))
        return GlanceEntry(
            date: date, paired: paired, plan: plan, error: WidgetStore.error,
            relevance: TimelineEntryRelevance(score: Float(score)))
    }

    static func timeline() -> Timeline<GlanceEntry> {
        let now = Date()
        let first = entry(at: now)
        guard first.paired else {
            let policy =
                WidgetTiming.signedOutReload(locked: TokenStore.lookup() == .locked, now: now).map { .after($0) }
                ?? TimelineReloadPolicy.never
            return Timeline(entries: [first], policy: policy)
        }
        let skew = ServerClock.skew
        let horizon = now.addingTimeInterval(6 * 3600)
        var times: [Date] = []
        if let plan = first.plan {
            times = Glance.redraws(plan, now: now.addingTimeInterval(skew), until: horizon.addingTimeInterval(skew)).map {
                $0.addingTimeInterval(-skew)
            }
        }
        let entries = [first] + times.prefix(90).map { entry(at: $0) }
        var next = now.addingTimeInterval(WidgetTiming.fallback)
        if let (plan, at) = WatchPlan.kept() {
            next = WidgetTiming.nextRefreshAt(plan, fetchedAt: at, now: now.addingTimeInterval(skew)).addingTimeInterval(-skew)
        }
        return Timeline(entries: entries, policy: .after(WidgetTiming.reloadAt(next, now: now)))
    }

    /// A made-up trip for the face's gallery, before the app has signed in: a bus to a class.
    static func sample() -> GlanceEntry {
        let now = Date()
        let iso = ISO8601DateFormatter()
        func t(_ min: Double) -> String { iso.string(from: now.addingTimeInterval(min * 60)) }
        let leave = campusTime(now.addingTimeInterval(9 * 60))
        let board = campusTime(now.addingTimeInterval(14 * 60))
        let json: [String: Any] = [
            "label": "D2 · \(board)", "detail": "", "quality": "live", "mode": "trip", "leave": ["at": t(9)],
            "card": [
                "kind": "class", "phase": "idle", "staleAt": t(30), "leaveBy": L("Leave by %@", leave), "title": "D2 · \(board)",
                "journey": [
                    "leave": leave, "walk": "5 min", "bus": ["svc": "D2", "color": "#8e44c9", "stop": "PGP", "board": board],
                    "boardAt": t(14), "ride": "10 min", "to": "GEA1000 @ UTown", "toStop": "UTown", "live": true,
                ],
            ],
        ]
        let plan = (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? NextAnswer.decode($0) }
        return GlanceEntry(date: now, paired: true, plan: plan, error: nil, relevance: nil)
    }
}

struct GlanceView: View {
    let entry: GlanceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let g = entry.glance
        Group {
            switch family {
            case .accessoryInline: InlineGlance(g: g)
            case .accessoryCircular: CircularGlance(g: g)
            default: RectangularGlance(g: g)
            }
        }
        .widgetURL(URL(string: "terminus://plan"))
        .containerBackground(for: .widget) { Color.clear }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(g))
    }

    /// One sentence for VoiceOver, as the iPhone's widgets say it.
    private func spoken(_ g: Glance) -> String {
        let now = entry.date.addingTimeInterval(ServerClock.skew)
        if let a = entry.plan, entry.paired, !WidgetFace.isOld(a, now: now) { return Spoken.summary(a, now: now) }
        return Spoken.sentences(g.heading, g.headline, g.under)
    }
}
