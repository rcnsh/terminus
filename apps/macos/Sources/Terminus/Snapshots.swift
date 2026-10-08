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
         "card":{"kind":"class","actions":[{"id":"skipped","label":"Not going","trip":"2:840:UTOWN"},{"id":"away","label":"Not on campus today","trip":"2:840:UTOWN"}],"crowd":"Crowding: low","leaveBy":"Leave by ~\(t(1080))","catch":"Catch the ~\(t(1380)) D2 at PGP","arrive":"Arrive ~\(t(1980)) · 3 min early","goNow":"Or go now: D2 at \(t(240)) · arrive \(t(840))","estimate":"Estimated from the usual gap between buses. Live times show nearer the time."},
         "arrivals":[{"svc":"D2","crowd":"low"}],
         "quality":"live","asOf":"2026-09-29T01:00:00Z","mode":"trip","dest":{"to":"UTOWN","label":"GEA1000 @ UTown","why":"class"},
         "places":[{"key":"mrt","label":"KR MRT"},{"key":"utown","label":"UTown"},{"key":"gym","label":"Gym"}]}
        """
        let answer = try! JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
        let nearbyJSON = """
        [{"stop":{"code":"PGP","name":"PGP"},"walkS":200,"available":true,"board":[{"svc":"D2","etaS":240,"eta":"4 min","quality":"live","color":"#8e44c9","later":[{"etaS":840,"eta":"14 min","quality":"live"},{"etaS":1500,"eta":"~25 min","quality":"scheduled"}]},{"svc":"A1","etaS":540,"eta":"9 min","quality":"live","color":"#e5484d","later":[{"etaS":1260,"eta":"21 min","quality":"live"}]},{"svc":"K","etaS":20,"eta":"now","quality":"live","color":"#2b9ad6"},{"svc":"R2","etaS":780,"eta":"13 min","quality":"live","color":"#34a853"},{"svc":"BTC1","etaS":1260,"eta":"~21 min","quality":"scheduled","later":[{"etaS":3060,"eta":"~51 min","quality":"scheduled"}]},{"svc":"95","etaS":360,"eta":"6 min","quality":"live","paid":true},{"svc":"E","etaS":null,"quality":"ended"}]},
         {"stop":{"code":"PGPR","name":"PGP Foyer"},"walkS":150,"available":true,"board":[{"svc":"A2","etaS":660,"eta":"11 min","quality":"live"}]}]
        """
        let nearby = try! JSONDecoder().decode([NearbyStop].self, from: Data(nearbyJSON.utf8))

        let restJSON = """
        {"label":"Done for today","detail":"Next: CS2030 @ COM1, tomorrow 10:00","alt":null,"stop":{"code":"","name":""},
         "card":{"kind":"rest","upcoming":{"when":"Tomorrow · Wed","title":"CS2030 at 10:00","where":"At COM1 · get off at COM 3","off":null}},
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
            // A place gone to from the search: its own tab, with an ×.
            m.added = [AppModel.AddedPlace(code: "COM3", label: "COM3")]
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
            ("later", {
                let m = model(nearbyTab: false)
                m.target = .code("COM3", label: "COM3")
                m.answers[.code("COM3", label: "COM3")] = answer
                return m
            }()),
            ("today", {
                let m = model(nearbyTab: false)
                let dayJSON = """
                {"date":"2026-10-01","items":[
                  {"kind":"class","key":"a","label":"MA1100 @ LT21","status":"done","fromName":"PGP","startsAt":"\(iso(-7200))"},
                  {"kind":"class","key":"b","label":"GEA1000 @ UTown","status":"next","fromName":"PGP","startsAt":"\(classAt)","leave":{"at":"\(leaves)","estimated":true,"svc":"D2","stop":"PGP"},"removable":true},
                  {"kind":"home","key":"h","label":"Home","status":"later","fromName":"UTown","startsAt":"\(iso(12600))","removable":true}
                ],"note":null}
                """
                m.day = try! JSONDecoder().decode(DayPlan.self, from: Data(dayJSON.utf8))
                // Just taken off today: the Undo bar.
                m.removed = try! JSONDecoder().decode(DayPlan.Item.self, from: Data(#"{"kind":"class","key":"c","label":"CS2030 @ COM1","status":"later","startsAt":"2026-10-01T05:00:00Z","removable":true}"#.utf8))
                return m
            }()),
            ("today-refused", {
                let m = model(nearbyTab: false)
                let dayJSON = """
                {"date":"2026-10-01","items":[
                  {"kind":"class","key":"b","label":"GEA1000 @ UTown","status":"next","fromName":"PGP","startsAt":"\(classAt)","leave":{"at":"\(leaves)","estimated":true,"svc":"D2","stop":"PGP"},"removable":true},
                  {"kind":"home","key":"h","label":"Home","status":"later","fromName":"UTown","startsAt":"\(iso(12600))","removable":true}
                ],"note":null}
                """
                m.day = try! JSONDecoder().decode(DayPlan.self, from: Data(dayJSON.utf8))
                m.removeFailed = ("b", "Couldn't reach terminus. Check your connection and try again.")
                return m
            }()),
        ]
        renderShowcase(to: dir)
        renderSetup(to: dir)
        renderGoldens(to: dir)
        renderMapStatus(to: dir)
        renderBusCards(to: dir)
        for (name, m) in cases {
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.95))] {
                let view = Popover(model: m, startShown: true)
                    .environment(\.fixedNow, Date())
                    .background(bg)
                    .environment(\.colorScheme, scheme)
                write(view, scale: 2, to: dir, as: "\(name)-\(scheme == .dark ? "dark" : "light")")
            }
        }
    }

    /// The API's golden answers (apps/api/test/fixtures/answers), at the
    /// moment they were answered: the journey's steps and the ride's line.
    static func renderGoldens(to dir: String) {
        let answers = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../api/test/fixtures/answers").standardized
        // Three of the ride's six stops behind it: the bus halfway along.
        let cases: [(String, String, String)] = [
            ("golden-scheduled", "scheduled.json", "2026-08-27T01:00:00Z"),
            ("golden-place", "place.json", "2026-08-27T01:00:00Z"),
            ("golden-riding", "riding.json", "2026-08-27T01:47:00Z"),
            ("golden-riding-zh", "zh/riding.json", "2026-08-27T01:47:00Z"),
            ("golden-class", "class-bus.json", "2026-08-27T01:00:00Z"),
        ]
        for (name, file, at) in cases {
            guard var o = (try? Data(contentsOf: answers.appendingPathComponent(file))).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let now = parseISODate(at) else { continue }
            // The riding golden goes stale before its ride: drawn mid-ride, it's kept fresh.
            if var card = o["card"] as? [String: Any], card["ride"] is [String: Any] {
                card["staleAt"] = "2026-08-27T01:55:00Z"
                o["card"] = card
            }
            guard let data = try? JSONSerialization.data(withJSONObject: o),
                  let a = try? JSONDecoder().decode(NextAnswer.self, from: data) else { continue }
            let m = AppModel(snapshot: true)
            m.paired = true
            m.answers = [.plan: a]
            m.places = a.places ?? []
            m.updated = now
            m.clock = now
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.95))] {
                let r = ImageRenderer(content: Popover(model: m, startShown: true).environment(\.fixedNow, now).background(bg).environment(\.colorScheme, scheme))
                r.scale = 2
                guard let img = r.nsImage, let tiff = img.tiffRepresentation,
                      let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { continue }
                try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"))
            }
        }
    }

    /// The map's status chips (the map itself is MapLibre's, which ImageRenderer can't draw).
    static func renderMapStatus(to dir: String) {
        let statuses: [MapModel.BusStatus] = [.running(3), .stale, .unavailable, .offline]
        let view = VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(statuses.enumerated()), id: \.offset) { _, s in StatusChip(text: s.text("D2")) }
        }
        .padding(.vertical, 12)
        .frame(width: 360, alignment: .leading)
        for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.85))] {
            let r = ImageRenderer(content: view.background(bg).environment(\.colorScheme, scheme))
            r.scale = 2
            guard let img = r.nsImage, let tiff = img.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { continue }
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("map-status-\(scheme == .dark ? "dark" : "light").png"))
        }
    }

    /// A clicked bus's card, shut and opened, between stops and at one.
    static func renderBusCards(to dir: String) {
        let ahead = ["LT 13", "AS 5", "BIZ 2", "PGP", "Kent Ridge MRT", "LT 27", "S 17", "UHC", "UTown"]
        var moving = LiveBus(id: "a", lat: 1.29, lon: 103.77, moving: true, crowd: "low", nextStop: "LT 13", plate: "PD539C")
        moving.stretch = Stretch(from: 0, to: 300, last: "CLB")
        moving.upcoming = ahead
        moving.towards = "UTown"
        var stopped = LiveBus(id: "b", lat: 1.29, lon: 103.77, moving: false, crowd: "high", nextStop: "BIZ 2", plate: "PD726D", at: "COM 3")
        stopped.upcoming = ["BIZ 2", "PGP"]
        stopped.towards = "Kent Ridge MRT"
        let cards: [(String, LiveBus, String, Bool)] = [("between", moving, "D1", false), ("between-open", moving, "D1", true), ("at-open", stopped, "A1", true)]
        for (name, bus, svc, open) in cards {
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.85))] {
                let hex = svc == "D1" ? "#C93BA4" : "#E0362F"
                let view = BusCard(bus: bus, svc: svc, hex: hex, close: {}, open: open)
                    .frame(width: 320)
                    .padding(16)
                    .background(bg)
                    .environment(\.colorScheme, scheme)
                write(view, scale: 2, to: dir, as: "map-bus-\(name)-\(scheme == .dark ? "dark" : "light")")
            }
        }
    }

    /// The setup steps and the devices window, from sample data.
    static func renderSetup(to dir: String) {
        let campusJSON = """
        {"stops":[{"code":"PGP","name":"Prince George's Park","lat":1.2917,"lon":103.7803},{"code":"COM3","name":"COM 3","lat":1.2948,"lon":103.7747},{"code":"UTOWN","name":"University Town","lat":1.3036,"lon":103.7747}],
         "residences":[{"code":"PGPR","name":"Prince George's Park Residences","stops":["PGP"],"walkM":300,"common":true},{"code":"RVRC","name":"Ridge View Residential College","stops":["COM3"],"walkM":420}]}
        """
        let campus = try! JSONDecoder().decode(Campus.self, from: Data(campusJSON.utf8))
        let profile: [String: Any] = ["home": ["stops": ["PGP"]], "homeWalkMin": 4, "walkPace": "normal", "fullBusMargin": true, "trips": [["day": 1, "arriveByMin": 600, "endMin": 720, "to": "COM3", "label": "CS2030 @ COM1"], ["day": 3, "arriveByMin": 840, "to": "UTOWN", "label": "GEA1000 @ UTown"], ["day": 4, "arriveByMin": 540, "to": "COM3", "label": "MA1100 @ LT21", "weeks": [1, 2, 3, 4, 5, 6]]], "manual": [["day": 5, "arriveByMin": 1080, "to": "UTOWN", "label": "Gym", "venue": ""]], "share": "https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1", "places": [["key": "mrt", "label": "KR MRT", "to": "KR-MRT"], ["key": "deck", "label": "The Deck", "to": "COM3"]]]
        let devices = [
            Device(id: "a", name: "MacBook Air", platform: "mac", lastSeen: Date().timeIntervalSince1970 * 1000, current: true),
            Device(id: "b", name: "Google Pixel 8", platform: "android", lastSeen: (Date().timeIntervalSince1970 - 7200) * 1000, current: false),
        ]
        let app = AppModel(snapshot: true)
        var views: [(String, AnyView)] = (0..<4).map { ("setup-\($0 + 1)", AnyView(SetupView(app: app, setup: SetupModel(profile: profile, campus: campus), step: $0))) }
        views.append(("devices", AnyView(DevicesView(setup: SetupModel(profile: profile, campus: campus, devices: devices, pairCode: "K7QX4M")))))
        // Settings' panes, as the window shows them beside its sidebar.
        app.places = [Place(key: "mrt", label: "KR MRT"), Place(key: "deck", label: "The Deck")]
        for pane in SettingsPane.allCases {
            let setup = SetupModel(profile: profile, campus: campus, devices: devices)
            views.append(("settings-\(pane.rawValue)", AnyView(SettingsPaneView(pane: pane, app: app, setup: setup).frame(width: 480, alignment: .leading).padding(24))))
        }
        for (name, view) in views {
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.95))] {
                write(view.background(bg).environment(\.colorScheme, scheme), scale: 2, to: dir, as: "\(name)-\(scheme == .dark ? "dark" : "light")")
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
         "card":{"kind":"class","crowd":"Crowding: low","leaveBy":"Leave by 9:41","catch":"Catch the 9:45 D2 at PGP","arrive":"Arrive 9:56 · 4 min early","goNow":"Or go now: D2 at 9:29 · arrive 9:40"},
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
            write(view, scale: 3, to: dir, as: "showcase-\(scheme == .dark ? "dark" : "light")")
        }
    }

    /// `view` as `dir/name.png`; nothing if it can't be drawn.
    private static func write(_ view: some View, scale: CGFloat, to dir: String, as name: String) {
        let r = ImageRenderer(content: view)
        r.scale = scale
        guard let img = r.nsImage, let tiff = img.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
#endif
