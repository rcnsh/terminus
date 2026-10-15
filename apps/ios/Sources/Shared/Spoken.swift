import Foundation

/// What VoiceOver says for the answer, on Now and on the widgets, and for a
/// bus's time. The sentences are the server's own words, joined; the app
/// words only what it works out itself (a countdown, rounded to the minute)
/// and spells out what the screen abbreviates ("~" is "about"). As Android's Spoken.
enum Spoken {
    /// The answer as sentences: where to, the trip's phase, the bus and its
    /// time, what to do, and how sure the times are. Without `withHead`, a
    /// plain card leaves out its phase and where to: Now reads those on their own.
    static func summary(_ a: NextAnswer, now: Date, withHead: Bool = true) -> String {
        let old = a.isOld(at: now)
        if a.phase == "riding", let ride = a.card?.ride {
            return sentences(
                a.dest.map { L("On the %@, to %@", ride.svc, $0.label) } ?? L("On the %@", ride.svc),
                L("Off at %@ at %@", ride.stops.last?.name ?? "", campusTime(ride.arriveAt)),
                ride.nextText(at: now, withChange: false),
                ride.change?.text,
                a.qualityText
            )
        }
        if a.isClassPlan && !old {
            return sentences(
                a.card?.phaseText,
                a.dest.map { L("%@, starts %@", $0.label, a.classAt.map(campusTime) ?? "") },
                a.leaveHeadline(now: now),
                a.card?.catchLine,
                a.card?.goNow,
                a.qualityText
            )
        }
        let head: String = {
            if a.mode == "rest" { return a.label }
            let parts = a.title.components(separatedBy: " · ")
            return parts.count == 2 ? L("%@, leaves %@", parts[0], parts[1]) : a.title
        }()
        return sentences(
            withHead ? a.card?.phaseText : nil,
            withHead ? a.dest.map { L("To %@", $0.label) } : nil,
            head,
            old ? L("These times are old") : a.detail,
            old ? nil : a.leaveText(now: now),
            old ? nil : a.timing?.text,
            old ? nil : a.qualityText
        )
    }

    /// How long until it's time to go, in words and to the minute ("Leave in
    /// 6 minutes"), for a card that counts down "6 min 32 s"; nil once it's time.
    static func countdown(_ a: NextAnswer, now: Date) -> String? {
        if let leave = a.leaveAt, leave > now, a.phase != "waiting" {
            return L("Leave in %@", minutes(leave.timeIntervalSince(now)))
        }
        guard let departs = a.departure, departs > now else { return nil }
        return L("Leaves in %@", minutes(departs.timeIntervalSince(now)))
    }

    /// Said when the card changes, and only then: the trip's phase, where to
    /// and the bus to catch. Nothing in it ticks.
    static func announcement(_ a: NextAnswer?) -> String? {
        guard let a else { return nil }
        var what: String?
        if a.phase == "riding" {
            what = nil
        } else if let bus = a.card?.journey?.bus {
            what = L("Bus %@ from %@", bus.svc, bus.stop)
        } else {
            // "D2 · 09:42": the service, without the time, which moves.
            what = a.title.components(separatedBy: " · ").first
        }
        var parts: [String] = []
        for p in [a.card?.phaseText, a.card?.heading ?? a.dest?.label, what].compactMap({ $0 }) where !parts.contains(p) { parts.append(p) }
        return parts.isEmpty ? nil : parts.joined(separator: sentenceStop)
    }

    /// "1 minute", "6 minutes", or "under a minute".
    static func minutes(_ seconds: TimeInterval) -> String {
        if seconds < 30 { return L("under a minute") }
        let m = Int((seconds + 30) / 60)
        return m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
    }

    /// A bus's time as it's said: "about 6 minutes, timetable" for a guess,
    /// "6 minutes, live" for a bus seen. Nil without a time.
    static func eta(_ etaS: Int?, quality: String, withQuality: Bool = true) -> String? {
        guard let s = etaS else { return nil }
        if s < BusTimes.arrivingS { return L("Arriving") }
        let m = minutes(TimeInterval(s))
        switch quality {
        case "scheduled": return withQuality ? L("about %@, timetable", m) : L("about %@", m)
        case "live": return withQuality ? L("%@, live", m) : m
        default: return L("about %@", m)
        }
    }

    /// "~09:42" as it's said: "about 09:42".
    static func spell(_ text: String) -> String {
        text.replacingOccurrences(of: #"~\s?"#, with: L("about") + (Lang.zh ? "" : " "), options: .regularExpression)
    }

    static var sentenceStop: String { Lang.zh ? "。" : ". " }

    /// The parts, each a sentence: "To KR MRT. A1, leaves 09:09. …".
    static func sentences(_ parts: String?...) -> String {
        let comma = Lang.zh ? "，" : ", "
        let body = parts.compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { p -> String in
            var s = spell(p.replacingOccurrences(of: " · ", with: comma))
            while s.hasSuffix(".") || s.hasSuffix("。") { s.removeLast() }
            return s
        }
        guard !body.isEmpty else { return "" }
        return body.joined(separator: sentenceStop) + sentenceStop.trimmingCharacters(in: .whitespaces)
    }
}
