import SwiftUI
import WidgetKit

struct BusEntry: TimelineEntry {
    var date: Date
    var paired: Bool
    var plan: NextAnswer?
    var error: String?
    var slot: WidgetStore.Slot?
    var slotID: String?
    var day: DayPlan?
    var added: [(code: String, label: String)] = []
    var nearby: [NearbyStop]?
    var nearbyAt: Date?
    var sample = false

    var serverNow: Date { date.addingTimeInterval(ServerClock.skew) }
}

struct BusProvider: TimelineProvider {
    let kind: String

    func placeholder(in context: Context) -> BusEntry { Self.sampleEntry(kind: kind, family: context.family) }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (BusEntry) -> Void) {
        let e = entry(at: Date(), family: context.family)
        completion(e.plan == nil && context.isPreview ? Self.sampleEntry(kind: kind, family: context.family) : e)
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<BusEntry>) -> Void) {
        let kind = kind
        let family = context.family
        Task {
            await Self.refreshIfDue(slot: Self.slotID(kind: kind, family: family))
            completion(Self.timeline(kind: kind, family: family))
        }
    }

    private func entry(at date: Date, family: WidgetFamily) -> BusEntry { Self.entry(kind: kind, family: family, at: date) }

    static func slotID(kind: String, family: WidgetFamily) -> String? {
        switch (kind, family) {
        case ("next", .systemLarge): "next.large"
        case ("places", .systemMedium): "places.medium"
        case ("places", .systemLarge): "places.large"
        default: nil
        }
    }

    static func entry(kind: String, family: WidgetFamily, at date: Date) -> BusEntry {
        let id = slotID(kind: kind, family: family)
        let paired = TokenStore.read() != nil
        return BusEntry(
            date: date,
            paired: paired,
            plan: paired ? WidgetStore.plan()?.0 : nil,
            error: WidgetStore.error,
            slot: id.map(WidgetStore.slot),
            slotID: id,
            day: paired ? WidgetStore.day() : nil,
            added: WidgetStore.added,
            nearby: paired ? NearbyShared.stops() : nil,
            nearbyAt: paired ? NearbyShared.fetchedAt : nil
        )
    }

    static func refreshIfDue(slot: String?) async {
        guard TokenStore.read() != nil, Date() >= Quiet.until(.app) else { return }
        let kept = WidgetStore.plan()
        let fetched = kept.map { $0.1.addingTimeInterval(ServerClock.skew) }
        if WidgetTiming.due(kept?.0, fetchedAt: fetched, now: ServerClock.now) { await refreshPlanOnce() }
        if let slot {
            let s = WidgetStore.slot(slot)
            if s.chosen != .timetable, let at = s.at, -at.timeIntervalSinceNow <= WidgetMode.keep,
                s.shownAt.map({ -$0.timeIntervalSinceNow >= WidgetMode.refetch }) ?? true
            {
                await WidgetStore.fetch(slot: slot)
            } else if slot == "next.large" {
                await NearbyShared.refreshIfDue(needsPlace: true)
            }
        }
    }

    private static let fetching = Mutex<Task<Void, Never>?>(nil)

    static func refreshPlanOnce() async {
        let task = fetching.withLock { t in
            if let t { return t }
            let new = Task {
                _ = await WidgetStore.refreshPlan()
                fetching.withLock { $0 = nil }
            }
            t = new
            return new
        }
        await task.value
    }

    static func unpairedPolicy(now: Date) -> TimelineReloadPolicy {
        WidgetTiming.signedOutReload(locked: TokenStore.lookup() == .locked, now: now).map { .after($0) } ?? .never
    }

    static func timeline(kind: String, family: WidgetFamily) -> Timeline<BusEntry> {
        let now = Date()
        let first = entry(kind: kind, family: family, at: now)
        guard first.paired else { return Timeline(entries: [first], policy: unpairedPolicy(now: now)) }
        let skew = ServerClock.skew
        let horizon = now.addingTimeInterval(6 * 3600)
        var moments: [Date] = []
        if let plan = first.plan {
            moments += WidgetTiming.redraws(plan, now: now.addingTimeInterval(skew), until: horizon.addingTimeInterval(skew)).map {
                $0.addingTimeInterval(-skew)
            }
        }
        if first.error != nil, let change = OfflineDay.nextChange(first.day, now: now.addingTimeInterval(skew)) {
            moments.append(change.addingTimeInterval(-skew))
        }
        if let stops = first.nearby, let f = first.nearbyAt,
            first.slot?.chosen == .nearby || family == .systemLarge
        {
            moments.append(f.addingTimeInterval(WidgetMode.nearbyOld + 1))
            moments += NearbyBoard.redraws(
                Array(stops.prefix(3)), fetchedAt: f, now: now, until: horizon, minutesUntil: f.addingTimeInterval(WidgetMode.nearbyOld),
                skew: skew)
        }
        if let s = first.slot, s.chosen != .timetable, let at = s.at {
            moments.append(at.addingTimeInterval(WidgetMode.keep + 1))
            if let a = s.answer {
                moments += WidgetTiming.redraws(a, now: now.addingTimeInterval(skew), until: horizon.addingTimeInterval(skew)).map {
                    $0.addingTimeInterval(-skew)
                }
            }
        }
        moments += skyChanges(after: now, until: horizon)
        let times = Array(Set(moments.filter { $0 > now && $0 < horizon }.map { $0.timeIntervalSince1970.rounded() })).sorted().prefix(60)
        let entries =
            [first]
            + times.map { t in
                var e = first
                e.date = Date(timeIntervalSince1970: t)
                return e
            }
        var next = now.addingTimeInterval(WidgetTiming.fallback)
        if let plan = first.plan, let at = WidgetStore.answerAt {
            next = WidgetTiming.nextRefreshAt(plan, fetchedAt: at.addingTimeInterval(skew), now: now.addingTimeInterval(skew))
                .addingTimeInterval(-skew)
        }
        if first.error != nil && first.error != WidgetFace.updating { next = min(next, now.addingTimeInterval(5 * 60)) }
        return Timeline(entries: entries, policy: .after(WidgetTiming.reloadAt(next, now: now)))
    }

    static func skyChanges(after now: Date, until: Date) -> [Date] {
        let cal = Calendar.current
        var out: [Date] = []
        for dayOffset in 0...1 {
            guard let day = cal.date(byAdding: .day, value: dayOffset, to: cal.startOfDay(for: now)) else { continue }
            for m in [390, 510, 990, 1125, 1180] {
                let d = day.addingTimeInterval(TimeInterval(m * 60))
                if d > now && d < until { out.append(d) }
            }
        }
        return out
    }

    static func sampleEntry(kind: String, family: WidgetFamily) -> BusEntry {
        let now = Date()
        let iso = ISO8601DateFormatter()
        func t(_ min: Double) -> String { iso.string(from: now.addingTimeInterval(min * 60)) }
        let leave = campusTime(now.addingTimeInterval(9 * 60))
        let board = campusTime(now.addingTimeInterval(14 * 60))
        let arrive = campusTime(now.addingTimeInterval(24 * 60))
        let json: [String: Any] = [
            "label": "D2 · \(board)", "detail": "", "quality": "live", "mode": "trip",
            "places": [["key": "mrt", "label": "KR MRT"], ["key": "utown", "label": "UTown"]],
            "dest": ["label": "GEA1000 @ UTown"], "leave": ["at": t(9)], "timing": ["classAt": t(40)],
            "card": [
                "kind": "class", "phase": "idle", "staleAt": t(30), "leaveBy": L("Leave by %@", leave), "title": "D2 · \(board)",
                "journey": [
                    "leave": leave, "walk": "5 min", "bus": ["svc": "D2", "color": "#8e44c9", "stop": "PGP", "board": board],
                    "boardAt": t(14),
                    "ride": "10 min", "to": "GEA1000 @ UTown", "toStop": "UTown", "arrive": arrive, "arriveStop": arrive, "live": true,
                    "title": L("To %@", "GEA1000 @ UTown"),
                ],
            ],
        ]
        let plan = (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? NextAnswer.decode($0) }
        return BusEntry(
            date: now, paired: true, plan: plan, error: nil, slot: nil, slotID: slotID(kind: kind, family: family), day: nil, sample: true)
    }
}
