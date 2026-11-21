import SwiftUI

enum JourneyStyle: String, CaseIterable {
    case steps, route

    static func of(_ pref: String) -> JourneyStyle { JourneyStyle(rawValue: pref) ?? .steps }

    var name: String {
        switch self {
        case .steps: L("Steps")
        case .route: L("Route")
        }
    }
}

private func shown(_ style: JourneyStyle, _ size: DynamicTypeSize) -> JourneyStyle {
    size >= .accessibility1 && style == .route ? .steps : style
}

struct JourneyTop: View {
    let answer: NextAnswer
    let journey: Journey
    let style: JourneyStyle
    let now: Date
    @Environment(\.inks) private var inks
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let a = answer
        let j = journey
        Text(JourneyText.to(a, j)).foregroundStyle(inks.muted).lineLimit(2)
        switch shown(style, typeSize) {
        case .route:
            LeaveHead(answer: a, journey: j, now: now)
            let under = [JourneyText.by(a, j, now: now), j.change == nil ? nil : JourneyText.walk(j), JourneyText.arrive(j)].compactMap {
                $0
            }.joined(separator: " · ")
            if !under.isEmpty { Text(under).foregroundStyle(a.leaveLate ? inks.late : inks.muted) }
        case .steps:
            LeaveHead(answer: a, journey: j, now: now)
            HStack(spacing: 8) {
                let under = [JourneyText.by(a, j, now: now), j.slack].compactMap { $0 }.joined(separator: " · ")
                if !under.isEmpty { Text(under).foregroundStyle(a.leaveLate ? inks.late : inks.muted) }
                if j.live { SkyPill(text: L("Live"), color: inks.good) }
                if !a.isClassPlan, let crowd = a.card?.crowd { SkyPill(text: crowd, color: inks.muted) }
            }
        }
    }
}

private struct LeaveHead: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let answer: NextAnswer
    let journey: Journey
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let text = JourneyText.leaveIn(answer, journey, now: now)
        let time = JourneyText.leaveTime(answer, journey, now: now)
        var s = AttributedString(text)
        s.foregroundColor = answer.leaveLate ? inks.late : inks.ink
        if !answer.leaveLate {
            if let time, let r = s.range(of: time) {
                s[r].foregroundColor = inks.accent
            } else if time == nil {
                s.foregroundColor = inks.accent
            }
        }
        return Text(s)
            .font(.system(size: 34 * scale, weight: .heavy))
            .tracking(-0.5)
            .monospacedDigit()
            .padding(.vertical, 2)
            .accessibilityIdentifier("now.leave")
    }
}

struct JourneyGround: View {
    let answer: NextAnswer
    let journey: Journey
    let style: JourneyStyle
    let now: Date
    var road = true
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let a = answer
        let j = journey
        VStack(alignment: .leading, spacing: 0) {
            if road { RoadLine(journey: j, now: now) }
            switch shown(style, typeSize) {
            case .route:
                RouteLine(journey: j).padding(.top, 16).padding(.bottom, 4)
                Tags(answer: a, journey: j)
            case .steps:
                StepsLine(answer: a, journey: j, now: now).padding(.top, 18)
                if let backup = JourneyText.backup(a, j) {
                    Label {
                        Text(backup)
                    } icon: {
                        Image(systemName: "bus")
                    }
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 14)
                }
            }
            let small = [a.leaveNote, a.card?.estimate].compactMap { $0 }
            if !small.isEmpty { Text(small.joined(separator: " ")).font(.footnote).foregroundStyle(Color.muted).padding(.top, 8) }
            if j.bus != nil && !j.live, let q = a.qualityText { Text(q).font(.footnote).foregroundStyle(Color.muted).padding(.top, 4) }
        }
        .accessibilityHidden(true)
    }
}

struct RoadLine: View {
    let journey: Journey
    let now: Date

    var body: some View {
        if let bus = journey.bus {
            let left = Int(journey.boardDate?.timeIntervalSince(now) ?? 0)
            var s = AttributedString(Self.words(stop: bus.stop, left: left, live: journey.live))
            if let r = s.range(of: bus.stop) { s[r].font = .body.weight(.bold) }
            return AnyView(
                HStack(spacing: 8) {
                    BusBadge(svc: bus.svc, color: bus.color, size: 14, paid: bus.paid)
                    Text(s)
                }
                .padding(.top, -12))
        }
        return AnyView(EmptyView())
    }

    nonisolated static func words(stop: String, left: Int, live: Bool) -> String {
        let n = Int((Double(left) / 60).rounded())
        if left <= 0 { return L("from %@", stop) }
        if !live { return L("reaches %@ in about %@ min", stop, "\(max(1, n))") }
        return left < BusTimes.arrivingS ? L("arriving at %@", stop) : L("reaches %@ in %@ min", stop, "\(n)")
    }
}

private struct Tags: View {
    let answer: NextAnswer
    let journey: Journey

    var body: some View {
        HStack(spacing: 6) {
            if journey.live { Pill(text: L("Live"), color: .good) }
            if !answer.isClassPlan, let crowd = answer.card?.crowd { Pill(text: crowd) }
        }
        .padding(.top, 10)
        if let backup = JourneyText.backup(answer, journey) {
            Text(backup).font(.subheadline).foregroundStyle(Color.muted).padding(.top, 8)
        }
    }
}

private struct RouteLine: View {
    let journey: Journey

    var body: some View {
        let j = journey
        HStack(alignment: .top, spacing: 0) {
            if let bus = j.bus {
                let change = j.change
                let narrow = j.walkEnd != nil || change != nil
                if change == nil, let walk = j.walk {
                    Point(name: L("You"), time: j.leave ?? L("now"), dot: .brand, narrow: narrow)
                    Stretch(takes: walk, line: .walk)
                }
                Point(name: bus.stop, time: bus.board, dot: .ink, narrow: narrow)
                Stretch(takes: change?.firstRide ?? j.ride ?? "", line: .ride(serviceColor(bus.color)), badge: bus).layoutPriority(1)
                if let c = change {
                    Point(name: c.from, time: (c.walk != nil ? c.reach : nil) ?? c.bus.board, dot: .ink, narrow: true)
                    if let walk = c.walk {
                        Stretch(takes: walk, line: .walk)
                        Point(name: c.stop, time: c.bus.board, dot: .ink, narrow: true)
                    }
                    Stretch(takes: c.ride ?? "", line: .ride(serviceColor(c.bus.color)), badge: c.bus).layoutPriority(1)
                }
                Point(name: j.toStop, time: (narrow ? j.arriveStop : j.arrive) ?? "", dot: .ink, narrow: narrow)
                if let walk = j.walkEnd {
                    Stretch(takes: walk, line: .walk)
                    Point(name: j.place, time: j.arrive ?? "", dot: .ink, narrow: true)
                }
            } else {
                Point(name: L("You"), time: j.leave ?? L("now"), dot: .brand)
                Stretch(takes: j.walk ?? "", line: .walk)
                Point(name: j.place, time: j.arrive ?? "", dot: .ink)
            }
        }
    }

    enum Kind {
        case walk
        case ride(Color)
    }

    struct Point: View {
        let name: String
        let time: String
        let dot: Color
        var narrow = false

        var body: some View {
            VStack(spacing: 0) {
                Spacer().frame(height: 22)
                Circle().fill(dot).frame(width: 14, height: 14).frame(height: 18)
                Text(name).font(.footnote.weight(.semibold)).lineLimit(2).multilineTextAlignment(.center).padding(.top, 4)
                Text(time).font(.caption).foregroundStyle(Color.muted).multilineTextAlignment(.center)
            }
            .frame(width: narrow ? 60 : 76)
        }
    }

    struct Stretch: View {
        let takes: String
        let line: Kind
        var badge: Journey.Bus?

        var body: some View {
            VStack(spacing: 0) {
                Group {
                    if let badge { BusBadge(svc: badge.svc, color: badge.color, size: 12, paid: badge.paid) } else { Color.clear }
                }
                .frame(height: 22)
                Canvas { g, size in
                    var p = Path()
                    p.move(to: CGPoint(x: 0, y: size.height / 2))
                    p.addLine(to: CGPoint(x: size.width, y: size.height / 2))
                    switch line {
                    case .walk: g.stroke(p, with: .color(.muted), style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 6]))
                    case .ride(let c): g.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    }
                }
                .frame(height: 18)
                Text(takes).font(.caption).foregroundStyle(Color.muted).lineLimit(1).fixedSize().padding(.top, 4)
                    .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct StepsLine: View {
    let answer: NextAnswer
    let journey: Journey
    let now: Date

    var body: some View {
        let a = answer
        let j = journey
        VStack(alignment: .leading, spacing: 0) {
            if j.walk != nil {
                LinePoint(time: j.leave ?? L("now"), dot: .start, line: .walk, below: JourneyText.walk(j)) {
                    Text(L("Leave")).font(.headline)
                }
            }
            if let bus = j.bus {
                LinePoint(
                    time: bus.board, dot: j.walk == nil ? .start : .stop, line: .ride(serviceColor(bus.color)),
                    below: j.change?.firstRideText ?? JourneyText.ride(j)
                ) {
                    HStack(spacing: 8) {
                        Text(bus.stop).font(.headline).lineLimit(2)
                        BusBadge(svc: bus.svc, color: bus.color, size: 13, paid: bus.paid)
                        if let busIn = JourneyText.busIn(j, now: now) {
                            Text(busIn).font(.caption).foregroundStyle(Color.muted).lineLimit(1).monospacedDigit()
                        }
                    }
                }
            }
            if let c = j.change {
                LinePoint(
                    time: c.bus.board, dot: .stop, line: .ride(serviceColor(c.bus.color)),
                    below: [c.changeText, c.rideText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                ) {
                    HStack(spacing: 8) {
                        Text(c.stop).font(.headline).lineLimit(2)
                        BusBadge(svc: c.bus.svc, color: c.bus.color, size: 13, paid: c.bus.paid)
                    }
                }
            }
            if j.walkEnd != nil {
                LinePoint(time: j.arriveStop ?? "", dot: .stop, line: .walk, below: JourneyText.walkEnd(j)) {
                    Text(j.toStop).font(.headline)
                }
            }
            LinePoint(time: j.arrive ?? "", dot: .end, line: nil, below: j.slack, late: a.leaveLate) {
                Text(j.bus == nil || j.walkEnd != nil ? j.place : j.toStop).font(.headline.weight(.bold))
            }
        }
    }

    enum Dot { case start, stop, end }
    enum Kind {
        case walk
        case ride(Color)
    }

    struct LinePoint<Title: View>: View {
        let time: String
        let dot: Dot
        let line: Kind?
        let below: String?
        var late = false
        @ViewBuilder var title: Title
        @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 72

        var body: some View {
            HStack(alignment: .top, spacing: 0) {
                Text(time).font(.subheadline.weight(.semibold)).frame(width: timeWidth, alignment: .leading).padding(.top, 3)
                VStack(spacing: 0) {
                    Canvas { g, size in
                        let c = CGPoint(x: size.width / 2, y: size.height / 2)
                        func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)) }
                        switch dot {
                        case .start: g.fill(circle(7), with: .color(.brand))
                        case .stop:
                            g.fill(circle(7), with: .color(.page))
                            g.stroke(circle(5.5), with: .color(.ink), lineWidth: 3)
                        case .end:
                            g.fill(circle(10), with: .color(.page))
                            g.stroke(circle(7), with: .color(.brand), lineWidth: 5.5)
                        }
                    }
                    .frame(width: 20, height: 20)
                    .padding(.top, 4)
                    if let line {
                        Canvas { g, size in
                            var p = Path()
                            p.move(to: CGPoint(x: size.width / 2, y: 0))
                            p.addLine(to: CGPoint(x: size.width / 2, y: size.height))
                            switch line {
                            case .walk: g.stroke(p, with: .color(.muted), style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 6]))
                            case .ride(let c): g.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                            }
                        }
                        .frame(maxHeight: .infinity)
                        .padding(.vertical, 3)
                    }
                }
                .frame(width: 26)
                .frame(maxHeight: .infinity, alignment: .top)
                VStack(alignment: .leading, spacing: 0) {
                    title
                    if let below {
                        let ride = if case .ride = line { true } else { false }
                        Text(below)
                            .font(.footnote)
                            .foregroundStyle(late ? Color.bad : Color.muted)
                            .padding(.top, ride ? 14 : 6)
                            .padding(.bottom, ride ? 14 : 0)
                    }
                }
                .padding(.leading, 10)
                .padding(.top, 1)
                .padding(.bottom, line == nil ? 0 : 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}
