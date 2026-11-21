import SwiftUI
import WidgetKit

struct Glance: Equatable {
    var svc: String?
    var color: String?
    var paid = false
    var heading: String?
    var headline: String
    var countdownTo: Date?
    var big: String?
    var under: String?
    var sure: String?
    var late = false
    var dim = false

    var short: String?
    var isCountdown = false

    var inline: String {
        if isCountdown { return svc.map { "\(headline) · \($0)" } ?? headline }
        return short ?? headline
    }

    static func of(paired: Bool, answer: NextAnswer?, error: String?, now: Date) -> Glance {
        guard paired else { return Glance(headline: "terminus", under: L("Open terminus on your iPhone")) }
        let face = WidgetFace.of(paired: true, mode: .timetable, answer: answer, error: error, offline: nil, now: now)
        guard let a = answer else { return Glance(headline: face.headline, under: face.sub) }
        let old = WidgetFace.isOld(a, now: now)
        let done = a.arrived || a.mode == "rest" || a.isFree
        if !old, !done, a.card?.phase != "riding", let j = a.card?.journey {
            var g = Glance(heading: j.place, headline: JourneyText.leaveIn(a, j, now: now), late: a.leaveLate, short: a.card?.glance)
            g.isCountdown = a.phase != "waiting"
            if let left = JourneyText.secondsToLeave(a, j, now: now) {
                if left < 120 {
                    g.countdownTo = a.leaveAt
                } else {
                    g.big = L("%@ min", "\((left + 30) / 60)")
                }
            } else {
                g.big = j.bus?.board ?? j.leave
            }
            if let bus = j.bus {
                g.svc = bus.svc
                g.color = bus.color
                g.paid = bus.paid
                g.under = L("from %@", bus.stop) + " " + bus.board
                g.sure = j.live ? L("Live") : "~"
            } else {
                g.under = JourneyText.arrive(j)
            }
            return g
        }
        return Glance(
            svc: face.leg?.svc, color: face.leg?.color, paid: face.leg?.paid ?? false,
            heading: face.heading, headline: face.headline, big: face.big, under: face.leg?.text ?? face.sub, late: face.late,
            dim: face.dim, short: old ? nil : a.card?.glance)
    }

    static func redraws(_ a: NextAnswer, now: Date, until: Date) -> [Date] {
        var out = WidgetTiming.redraws(a, now: now, until: until)
        if let j = a.card?.journey, a.phase != "waiting", j.leave != nil, let leave = a.leaveAt {
            let holds = a.staleAt ?? until
            var count = (2...60).map { leave.addingTimeInterval(-(Double($0) * 60 + 29.5)) }
            count += [leave.addingTimeInterval(-119.5), leave]
            out += count.filter { $0 < holds }
        }
        return Array(Set(out.filter { $0 > now && $0 < until })).sorted()
    }

    static func relevance(paired: Bool, answer: NextAnswer?, now: Date) -> Double {
        guard paired, let a = answer, !WidgetFace.isOld(a, now: now) else { return 0 }
        if TripPrefs.tripPhases.contains(a.phase) { return 1 }
        if let leave = a.leaveAt, leave > now, leave.timeIntervalSince(now) < 3600 { return 0.8 }
        return 0.1
    }
}

private let ink = Color(rgb: 0xF2EFEB)

struct InlineGlance: View {
    let g: Glance

    var body: some View {
        if let to = g.countdownTo {
            let parts = L("Leave in %@", "\u{1}").components(separatedBy: "\u{1}")
            Text(verbatim: parts.first ?? "") + Text(timerInterval: Date.now...max(Date.now, to), countsDown: true)
                + Text(verbatim: (parts.count > 1 ? parts[1] : "") + (g.svc.map { " · \($0)" } ?? ""))
        } else {
            Label {
                Text(verbatim: g.inline)
            } icon: {
                Image(systemName: "bus.fill")
            }
        }
    }
}

struct CircularGlance: View {
    let g: Glance

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let svc = g.svc {
                    Text(verbatim: svc).font(.system(size: 12, weight: .heavy)).lineLimit(1).minimumScaleFactor(0.6)
                        .foregroundStyle(Color(hex: g.color) ?? ink).widgetAccentable()
                } else {
                    Image(systemName: "bus.fill").font(.system(size: 12)).widgetAccentable()
                }
                Group {
                    if let to = g.countdownTo {
                        Text(timerInterval: Date.now...max(Date.now, to), countsDown: true).multilineTextAlignment(.center)
                    } else {
                        Text(verbatim: g.big ?? "–")
                    }
                }
                .font(.system(size: 15, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            }
            .padding(4)
        }
    }
}

struct RectangularGlance: View {
    let g: Glance

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                if let svc = g.svc {
                    Text(verbatim: g.paid ? "\(svc) $" : svc).font(.system(size: 13, weight: .heavy)).foregroundStyle(
                        inkOn(hexRGB(g.color ?? ""))
                    )
                    .padding(.horizontal, 4)
                    .background(serviceColor(g.color), in: RoundedRectangle(cornerRadius: 4))
                    .widgetAccentable()
                }
                Text(verbatim: g.heading ?? "terminus").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            }
            Group {
                if let to = g.countdownTo {
                    let parts = L("Leave in %@", "\u{1}").components(separatedBy: "\u{1}")
                    Text(verbatim: parts.first ?? "") + Text(timerInterval: Date.now...max(Date.now, to), countsDown: true)
                        + Text(verbatim: parts.count > 1 ? parts[1] : "")
                } else {
                    Text(verbatim: g.headline)
                }
            }
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(g.late ? Color.bad : g.dim ? Color.muted : ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .widgetAccentable()
            if g.under != nil || g.sure != nil {
                HStack(spacing: 4) {
                    if let under = g.under { Text(verbatim: under).lineLimit(1) }
                    if let sure = g.sure {
                        Text(verbatim: sure).fontWeight(.semibold).foregroundStyle(sure == "~" ? Color.muted : Color.good).layoutPriority(1)
                    }
                }
                .font(.system(size: 14))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
