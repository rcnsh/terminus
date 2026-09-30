#if DEBUG
import SwiftUI

/// `TERMINUS_SNAPSHOT=/tmp/dir swift run` renders the popover with sample data
/// to PNGs and exits. For checking layout without clicking the menu bar.
@MainActor
enum Snapshots {
    static func render(to dir: String) {
        // Milliseconds, like the API used to send: keeps the parser honest.
        let departs = ISO8601DateFormatter().string(from: Date().addingTimeInterval(240)).replacingOccurrences(of: "Z", with: ".000Z")
        let iso = { (s: Double) in ISO8601DateFormatter().string(from: Date().addingTimeInterval(s)) }
        let leaves = iso(1080), boards = iso(1380), arrives = iso(1980), classAt = iso(2160), reach = iso(840)
        // The card is worded on the server; here, the same words by hand.
        let t = { (s: Double) in campusTime(Date().addingTimeInterval(s)) }
        let json = """
        {"label":"D2 · 4 min","detail":"PGP · 3 min walk · UTown ~12 min · or A1 9 min","alt":"A1 · 9 min","stop":{"code":"PGP","name":"PGP"},
         "departsAt":"\(departs)",
         "timing":{"status":"on-time","text":"Arrive 09:52 · 8 min early","classAt":"\(classAt)","reachAt":"\(reach)"},
         "leave":{"at":"\(leaves)","estimated":true,"svc":"D2","stop":"PGP","board":"\(boards)","arrive":"\(arrives)"},
         "card":{"kind":"class","crowd":"Quiet","leaveBy":"Leave by ~\(t(1080))","catch":"Catch the ~\(t(1380)) D2 at PGP","arrive":"Arrive ~\(t(1980)) · 3 min early","goNow":"Or go now: D2 at \(t(240)) · arrive \(t(840))","estimate":"Estimated from the usual gap between buses. Live times show nearer the time."},
         "arrivals":[{"svc":"D2","crowd":"low"}],
         "quality":"live","asOf":"2026-09-29T01:00:00Z","mode":"trip","dest":{"to":"UTOWN","label":"GEA1000 @ UTown","why":"class"},
         "places":[{"key":"mrt","label":"KR MRT"},{"key":"utown","label":"UTown"},{"key":"gym","label":"Gym"}]}
        """
        let answer = try! JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
        let nearbyJSON = """
        [{"stop":{"code":"PGP","name":"PGP"},"walkS":200,"available":true,"board":[{"svc":"D2","etaS":240,"quality":"live"},{"svc":"A1","etaS":540,"quality":"live"},{"svc":"K","etaS":20,"quality":"live"},{"svc":"R2","etaS":780,"quality":"live"},{"svc":"BTC1","etaS":1260,"quality":"scheduled"},{"svc":"E","etaS":null,"quality":"ended"}]},
         {"stop":{"code":"PGPR","name":"PGP Foyer"},"walkS":150,"available":true,"board":[{"svc":"A2","etaS":660,"quality":"live"}]}]
        """
        let nearby = try! JSONDecoder().decode([NearbyStop].self, from: Data(nearbyJSON.utf8))

        let restJSON = """
        {"label":"Done for today","detail":"Next: CS2030 @ COM1, tomorrow 10:00","alt":null,"stop":{"code":"","name":""},
         "quality":"ended","asOf":"2026-09-29T12:00:00Z","mode":"rest","dest":null,"places":[{"key":"mrt","label":"KR MRT"}]}
        """
        let rest = try! JSONDecoder().decode(NextAnswer.self, from: Data(restJSON.utf8))

        func model(nearbyTab: Bool, paired: Bool = true, resting: Bool = false) -> AppModel {
            let m = AppModel(snapshot: true)
            m.paired = paired
            m.answers = [.plan: resting ? rest : answer]
            m.places = answer.places ?? []
            m.nearby = nearby
            m.showNearby = nearbyTab
            m.updated = Date()
            return m
        }

        let cases: [(String, AppModel)] = [
            ("next", model(nearbyTab: false)),
            ("nearby", model(nearbyTab: true)),
            ("pair", model(nearbyTab: false, paired: false)),
            ("signin", {
                let m = model(nearbyTab: false, paired: false)
                m.signInWaiting = ("you@u.nus.edu", 47)
                return m
            }()),
            ("rest", model(nearbyTab: false, resting: true)),
        ]
        renderShowcase(to: dir)
        for (name, m) in cases {
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.95))] {
                let view = Popover(model: m, startShown: true)
                    .environment(\.fixedNow, Date())
                    .background(bg)
                    .environment(\.colorScheme, scheme)
                let r = ImageRenderer(content: view)
                r.scale = 2
                guard let img = r.nsImage, let tiff = img.tiffRepresentation,
                      let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { continue }
                try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"))
            }
        }
    }

    /// For the landing page: a weekday morning, a class with a leave-by time,
    /// at 3x, light and dark from identical data so the halves line up.
    static func renderShowcase(to dir: String) {
        // Tuesday 29 Sep 2026, 09:24 in Singapore.
        let now = ISO8601DateFormatter().date(from: "2026-09-29T01:24:00Z")!
        let iso = { (s: Double) in ISO8601DateFormatter().string(from: now.addingTimeInterval(s)) }
        let json = """
        {"label":"D2 · 5 min","detail":"PGP · 3 min walk · CS2030 @ COM1 ~11 min · quiet · or A1 9 min","alt":"A1 · 9 min","stop":{"code":"PGP","name":"PGP"},
         "departsAt":"\(iso(300))",
         "timing":{"status":"on-time","text":"","classAt":"\(iso(2160))","reachAt":"\(iso(960))"},
         "leave":{"at":"\(iso(1020))","estimated":false,"svc":"D2","stop":"PGP","board":"\(iso(1260))","arrive":"\(iso(1920))"},
         "card":{"kind":"class","crowd":"Quiet","leaveBy":"Leave by 9:41","catch":"Catch the 9:45 D2 at PGP","arrive":"Arrive 9:56 · 4 min early","goNow":"Or go now: D2 at 9:29 · arrive 9:40"},
         "arrivals":[{"svc":"D2","crowd":"low"}],
         "quality":"live","asOf":"2026-09-29T01:24:00Z","mode":"trip","dest":{"to":"COM3","label":"CS2030 @ COM1","why":"class"},
         "places":[{"key":"mrt","label":"KR MRT"},{"key":"utown","label":"UTown"},{"key":"deck","label":"The Deck"}]}
        """
        let answer = try! JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
        let m = AppModel(snapshot: true)
        m.paired = true
        m.answers = [.plan: answer]
        m.places = answer.places ?? []
        m.updated = now
        // The popover's own surface, in the brand's warm neutrals.
        for (scheme, bg) in [(ColorScheme.light, Color(red: 0.965, green: 0.961, blue: 0.953)), (.dark, Color(red: 0.137, green: 0.129, blue: 0.122))] {
            let view = Popover(model: m, startShown: true)
                .environment(\.fixedNow, now)
                .background(bg)
                .environment(\.colorScheme, scheme)
            let r = ImageRenderer(content: view)
            r.scale = 3
            guard let img = r.nsImage, let tiff = img.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { continue }
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("showcase-\(scheme == .dark ? "dark" : "light").png"))
        }
    }
}
#endif
