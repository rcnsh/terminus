import SwiftUI

/// How Now draws a trip by bus or on foot, chosen in Settings › Appearance.
/// Each leads with when to leave and ends with when you get there; the
/// words and times are the server's (`card.journey`), only the countdowns
/// tick here. As Android's CardStyle and JourneyCard.
///
/// - steps: the trip as a line diagram down the card, as on a bus's route
///   map: the walk dotted, the ride in the bus's colour. The default.
/// - route: a line across, from you to the stop to where you're going.
/// - ticket: the bus first, as a badge in its colour, then when to leave
///   and when you get there.
enum JourneyStyle: String, CaseIterable {
    case steps, route, ticket

    static func of(_ pref: String) -> JourneyStyle { JourneyStyle(rawValue: pref) ?? .steps }

    var name: String {
        switch self {
        case .steps: L("Steps")
        case .route: L("Route")
        case .ticket: L("Ticket")
        }
    }
}

/// At a large text size the route's points are too narrow for their names
/// and times: the trip as steps then, one point to a line.
private func shown(_ style: JourneyStyle, _ size: DynamicTypeSize) -> JourneyStyle {
    size >= .accessibility1 && style == .route ? .steps : style
}

/// The top of the trip, up in the sky.
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
            let under = [JourneyText.by(a, j, now: now), JourneyText.arrive(j)].compactMap { $0 }.joined(separator: " · ")
            if !under.isEmpty { Text(under).foregroundStyle(a.leaveLate ? inks.late : inks.muted) }
        case .steps:
            LeaveHead(answer: a, journey: j, now: now)
            HStack(spacing: 8) {
                let under = [JourneyText.by(a, j, now: now), j.slack].compactMap { $0 }.joined(separator: " · ")
                if !under.isEmpty { Text(under).foregroundStyle(a.leaveLate ? inks.late : inks.muted) }
                if j.live { SkyPill(text: L("Live"), color: inks.good) }
                if !a.isClassPlan, let crowd = a.card?.crowd { SkyPill(text: crowd, color: inks.muted) }
            }
        case .ticket:
            TicketTop(answer: a, journey: j, now: now)
        }
    }
}

/// "Leave in 6 min" as one line at one size, with only the time in the
/// accent, so it reads first. "Leave now" is all accent; too late to be on
/// time, all red.
private struct LeaveHead: View {
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
            .font(.system(size: 34, weight: .heavy))
            .tracking(-0.5)
            .monospacedDigit()
            .padding(.vertical, 2)
            .accessibilityIdentifier("now.leave")
    }
}

/// Ticket: the bus first, as you'd look for it on the road, then when to
/// leave and when you get there. On foot, the walk in its place.
private struct TicketTop: View {
    let answer: NextAnswer
    let journey: Journey
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let a = answer
        let j = journey
        HStack(spacing: 14) {
            if let bus = j.bus {
                let rgb = bus.color.flatMap(hexRGB) ?? 0x8A847E
                Text(bus.paid ? "\(bus.svc) $" : bus.svc)
                    .font(.system(size: 26, weight: .heavy))
                    .lineLimit(1)
                    .foregroundStyle(inkOn(rgb))
                    .padding(.horizontal, 6)
                    .frame(minWidth: 64, minHeight: 64)
                    .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .lastTextBaseline, spacing: 4) {
                        Text(bus.board).font(.title2.weight(.bold))
                        if let busIn = JourneyText.busIn(j, now: now) {
                            Text(busIn).font(.subheadline.weight(.semibold)).foregroundStyle(inks.muted).monospacedDigit()
                        }
                    }
                    Text(([L("from %@", bus.stop)] + [JourneyText.walk(j)].compactMap { $0 }).joined(separator: " · "))
                }
            } else {
                Image(systemName: "figure.walk")
                    .font(.system(size: 30, weight: .semibold))
                    .frame(width: 64, height: 64)
                    .background(inks.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(JourneyText.walk(j) ?? "").font(.title2.weight(.bold))
                    Text(j.why ?? L("Walk to %@", j.place))
                }
            }
        }
        .padding(.top, 10)
        let tint = a.leaveLate ? inks.late : inks.accent
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(JourneyText.leaveIn(a, j, now: now)).font(.title3.weight(.bold)).foregroundStyle(tint).monospacedDigit()
                if let by = JourneyText.by(a, j, now: now) { Text(by).font(.footnote).foregroundStyle(inks.muted) }
            }
            Spacer(minLength: 8)
            if let arrive = j.arrive {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(L("Arrive %@", arrive)).font(.subheadline.weight(.semibold))
                    Text(JourneyText.arriveWhere(j)).font(.footnote).foregroundStyle(a.leaveLate ? inks.late : inks.muted)
                }
                .multilineTextAlignment(.trailing)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.top, 14)
    }
}

/// The rest of the trip, on the ground under the horizon.
struct JourneyGround: View {
    let answer: NextAnswer
    let journey: Journey
    let style: JourneyStyle
    let now: Date
    /// The horizon's road in words; only on Now, where the horizon is.
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
            case .ticket:
                if j.bus != nil { Tags(answer: a, journey: j) }
            case .steps:
                StepsLine(answer: a, journey: j, now: now).padding(.top, 18)
                if let backup = JourneyText.backup(a, j) {
                    Text(backup)
                        .font(.subheadline)
                        .foregroundStyle(Color.muted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
                        .padding(.top, 14)
                }
            }
            // A busy bus and an estimate are small print, not more headlines.
            let small = [a.leaveNote, a.card?.estimate].compactMap { $0 }
            if !small.isEmpty { Text(small.joined(separator: " ")).font(.footnote).foregroundStyle(Color.muted).padding(.top, 8) }
            // On foot, the bus's data quality isn't about the walk: `why` says what matters.
            if j.bus != nil && !j.live, let q = a.qualityText { Text(q).font(.footnote).foregroundStyle(Color.muted).padding(.top, 4) }
        }
        // The card is read as one sentence, up in the sky.
        .accessibilityHidden(true)
    }
}

/// The horizon's road in words, just under it: your bus and when it reaches
/// your stop ("about" for a timetable guess), the stop's name in bold.
private struct RoadLine: View {
    let journey: Journey
    let now: Date

    var body: some View {
        if let bus = journey.bus {
            let left = Int(journey.boardDate?.timeIntervalSince(now) ?? 0)
            let n = "\(Int((Double(left) / 60).rounded()))"
            let text =
                left <= 0
                ? L("from %@", bus.stop)
                : left < BusTimes.arrivingS
                    ? L("arriving at %@", bus.stop)
                    : journey.live
                        ? L("reaches %@ in %@ min", bus.stop, n)
                        : L("reaches %@ in about %@ min", bus.stop, n)
            var s = AttributedString(text)
            if let r = s.range(of: bus.stop) { s[r].font = .body.weight(.bold) }
            return AnyView(
                HStack(spacing: 8) {
                    BusBadge(svc: bus.svc, color: bus.color, size: 14, paid: bus.paid)
                    Text(s)
                }
                // Up into the strip under the road, which is just the near hill.
                .padding(.top, -12))
        }
        return AnyView(EmptyView())
    }
}

/// Live (or not), the crowd, and the backup bus, as tags under the trip.
private struct Tags: View {
    let answer: NextAnswer
    let journey: Journey

    var body: some View {
        HStack(spacing: 6) {
            if journey.live { Pill(text: L("Live"), color: .good) }
            // The crowd is the headline bus's: a class's leave-by bus can be another.
            if !answer.isClassPlan, let crowd = answer.card?.crowd { Pill(text: crowd) }
        }
        .padding(.top, 10)
        if let backup = JourneyText.backup(answer, journey) {
            Text(backup).font(.subheadline).foregroundStyle(Color.muted).padding(.top, 8)
        }
    }
}

/// Route: you, the stop and where you're going on a line, the times under
/// each; a dashed walk, the bus's stretch in its colour. On foot, you and
/// the place, the walk between.
private struct RouteLine: View {
    let journey: Journey

    var body: some View {
        let j = journey
        HStack(alignment: .top, spacing: 0) {
            if let bus = j.bus {
                let narrow = j.walkEnd != nil
                if let walk = j.walk {
                    Point(name: L("You"), time: j.leave ?? L("now"), dot: .brand, narrow: narrow)
                    Stretch(takes: walk, line: .walk)
                }
                Point(name: bus.stop, time: bus.board, dot: .ink, narrow: narrow)
                Stretch(takes: j.ride ?? "", line: .ride(serviceColor(bus.color)), badge: bus).layoutPriority(1)
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

    /// A point on the line: a dot, its name and its time.
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

    /// Between two points: the bus above the line (nothing for a walk), the line level with the dots, how long under it.
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
                // Wider than a short stretch: drawn past its ends, over the gap beside the names.
                Text(takes).font(.caption).foregroundStyle(Color.muted).lineLimit(1).fixedSize().padding(.top, 4)
                    .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

/// Steps: the trip as a line diagram, as on a bus's route map. Each point
/// has its time on the left and a dot on the line; between them the walk is
/// dotted and the ride drawn in the bus's colour; where you're going is
/// ringed in the accent.
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
                    time: bus.board, dot: j.walk == nil ? .start : .stop, line: .ride(serviceColor(bus.color)), below: JourneyText.ride(j)
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

    /// A point on the line: its time, its dot, what's there, and under it how
    /// long the stretch to the next point takes, which the line runs beside.
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
