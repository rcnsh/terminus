import Foundation

enum Spoken {
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
                a.dest.map {
                    $0.place == true
                        ? L("%@, arrive by %@", $0.label, a.classAt.map(campusTime) ?? "")
                        : L("%@, starts %@", $0.label, a.classAt.map(campusTime) ?? "")
                },
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
            old || a.card?.ride != nil ? nil : a.timing?.text,
            old ? nil : a.qualityText
        )
    }

    static func countdown(_ a: NextAnswer, now: Date) -> String? {
        if let leave = a.leaveAt, leave > now, a.phase != "waiting" {
            return L("Leave in %@", minutes(leave.timeIntervalSince(now)))
        }
        guard let departs = a.departure, departs > now else { return nil }
        return L("Leaves in %@", minutes(departs.timeIntervalSince(now)))
    }

    static func announcement(_ a: NextAnswer?) -> String? {
        guard let a else { return nil }
        var what: String?
        if a.phase == "riding" {
            what = nil
        } else if let bus = a.card?.journey?.bus {
            what = L("Bus %@ from %@", bus.svc, bus.stop)
        } else {
            what = a.title.components(separatedBy: " · ").first
        }
        var parts: [String] = []
        for p in [a.card?.phaseText, a.card?.heading ?? a.dest?.label, what].compactMap({ $0 }) where !parts.contains(p) { parts.append(p) }
        return parts.isEmpty ? nil : parts.joined(separator: sentenceStop)
    }

    static func minutes(_ seconds: TimeInterval) -> String {
        if seconds < 30 { return L("under a minute") }
        let m = Int((seconds + 30) / 60)
        return m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
    }

    static func eta(_ etaS: Int?, quality: String, withQuality: Bool = true) -> String? {
        guard let s = etaS else { return nil }
        if s < BusTimes.arrivingS && quality == "live" { return L("Arriving") }
        let m = minutes(TimeInterval(quality == "live" ? s : max(s, 60)))
        switch quality {
        case "scheduled": return withQuality ? L("about %@, estimated", m) : L("about %@", m)
        case "live": return withQuality ? L("%@, live", m) : m
        default: return L("about %@", m)
        }
    }

    static func spell(_ text: String) -> String {
        text.replacingOccurrences(of: #"~\s?"#, with: L("about") + (Lang.zh ? "" : " "), options: .regularExpression)
    }

    static var sentenceStop: String { Lang.zh ? "。" : ". " }

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
