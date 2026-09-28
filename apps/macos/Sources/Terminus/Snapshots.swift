#if DEBUG
import SwiftUI

/// `TERMINUS_SNAPSHOT=/tmp/dir swift run` renders the popover with sample data
/// to PNGs and exits. For checking layout without clicking the menu bar.
@MainActor
enum Snapshots {
    static func render(to dir: String) {
        let json = """
        {"label":"D2 · 4 min","detail":"PGP · 3 min walk · UTown ~12 min · or A1 9 min","alt":"A1 · 9 min","stop":{"code":"PGP","name":"PGP"},
         "departsAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(240)))",
         "timing":{"status":"on-time","text":"Arrive 09:52 · 8 min early"},
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
            ("rest", model(nearbyTab: false, resting: true)),
        ]
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
}
#endif
