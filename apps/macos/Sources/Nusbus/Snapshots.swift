#if DEBUG
import SwiftUI

/// `NUSBUS_SNAPSHOT=/tmp/dir swift run` renders the popover with sample data
/// to PNGs and exits. For checking layout without clicking the menu bar.
@MainActor
enum Snapshots {
    static func render(to dir: String) {
        let json = """
        {"label":"D2 · 4 min","detail":"Leave in 1 min · 3 min walk to PGP","alt":"A1 · 9 min","stop":{"code":"PGP","name":"PGP"},
         "quality":"live","asOf":"2026-09-29T01:00:00Z","mode":"trip","dest":{"to":"UTOWN","label":"GEA1000 @ UTown","why":"class"},
         "places":[{"key":"mrt","label":"KR MRT"},{"key":"utown","label":"UTown"},{"key":"gym","label":"Gym"}]}
        """
        let answer = try! JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
        let nearbyJSON = """
        [{"stop":{"code":"PGP","name":"PGP"},"walkS":200,"available":true,"board":[{"svc":"D2","etaS":240,"quality":"live"},{"svc":"A1","etaS":540,"quality":"live"},{"svc":"K","etaS":20,"quality":"live"}]},
         {"stop":{"code":"PGPR","name":"PGP Foyer"},"walkS":150,"available":true,"board":[{"svc":"A2","etaS":660,"quality":"live"}]}]
        """
        let nearby = try! JSONDecoder().decode([NearbyStop].self, from: Data(nearbyJSON.utf8))

        func model(nearbyTab: Bool, paired: Bool = true) -> AppModel {
            let m = AppModel(snapshot: true)
            m.paired = paired
            m.answers = [.plan: answer]
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
        ]
        for (name, m) in cases {
            for (scheme, bg) in [(ColorScheme.dark, Color(white: 0.16)), (.light, Color(white: 0.95))] {
                let view = Popover(model: m, startShown: true)
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
