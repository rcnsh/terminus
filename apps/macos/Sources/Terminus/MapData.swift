import Foundation

// The map window's data: stops and routes from `/campus`, live buses from
// `/buses`, and the GeoJSON the map draws from them. Plain JSON in and out,
// so it's tested without a map (MapDataTests); the same as the phone's
// MapData.kt.

/// A stop on the map, with the services that call there.
struct MapStop: Hashable {
    let code: String
    let name: String
    let lat: Double
    let lon: Double
    let services: [String]
}

/// A service: its colour ("#e53935"), its path along the roads as [lon, lat] pairs, and whether it's a loop.
struct MapRoute {
    let svc: String
    let color: String
    let line: [[Double]]
    let loop: Bool
    /// The line measured for sliding buses along it.
    let path: RoutePath

    init(svc: String, color: String, line: [[Double]], loop: Bool = false) {
        self.svc = svc
        self.color = color
        self.line = line
        self.loop = loop
        path = RoutePath(line, loop: loop)
    }

    /// [west, south, east, north] of the line.
    var bounds: [Double] {
        [line.map { $0[0] }.min()!, line.map { $0[1] }.min()!, line.map { $0[0] }.max()!, line.map { $0[1] }.max()!]
    }
}

/// A route line measured as the API measures it (haversine, metres from its
/// start at each point), so a bus's `along` is a place on it. `closed` is the
/// service's `loop` from /campus, as the API places buses: a loop's line
/// needn't end exactly where it starts (A1's ends are some 40 m apart at KRB).
struct RoutePath {
    private let line: [[Double]]
    private let cum: [Double]
    let total: Double
    /// A loop: a bus can slide on past the start.
    let closed: Bool

    /// Further than this in one answer (back from sleep), a bus jumps.
    static let slideMaxM = 1_500.0

    init(_ line: [[Double]], loop: Bool = false) {
        self.line = line
        var c = [Double](repeating: 0, count: line.count)
        for i in line.indices.dropFirst() { c[i] = c[i - 1] + Self.haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]) }
        cum = c
        total = c.last ?? 0
        closed = loop && line.count >= 2
    }

    /// The point `m` metres along, as (lat, lon, the road's bearing there).
    func point(at m: Double) -> (lat: Double, lon: Double, bearing: Double) {
        let at = wrap(m)
        var lo = 0, hi = cum.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if cum[mid] <= at { lo = mid } else { hi = mid }
        }
        let a = line[lo], b = line[hi]
        let seg = cum[hi] - cum[lo]
        let t = seg > 0 ? (at - cum[lo]) / seg : 0
        return (a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t, Self.bearing(a[1], a[0], b[1], b[0]))
    }

    /// The part of the line from `a` to `b` metres along it, as [lon, lat]
    /// points; nil when that isn't a stretch of this line.
    func slice(_ a: Double, _ b: Double) -> [[Double]]? {
        guard line.count >= 2, b > a, a >= 0, b <= total + 1 else { return nil }
        func end(_ m: Double) -> [Double] { let p = point(at: min(m, total)); return [p.lon, p.lat] }
        return [end(a)] + line.indices.filter { cum[$0] > a && cum[$0] < b }.map { line[$0] } + [end(b)]
    }

    /// `m` as a place on the line: round again on a loop, else held to its ends.
    func wrap(_ m: Double) -> Double {
        guard total > 0 else { return 0 }
        return closed ? (m.truncatingRemainder(dividingBy: total) + total).truncatingRemainder(dividingBy: total) : min(max(m, 0), total)
    }

    /// Metres on along the line from bus `f` to bus `b`, round a loop past its
    /// start; nil when it isn't on ahead: the same place, behind, a long way,
    /// or a line kept from before the route changed.
    func ahead(from f: LiveBus, to b: LiveBus) -> Double? {
        guard let fa = f.along, let ba = b.along, line.count >= 2, total > 0, fa <= total + 1, ba <= total + 1 else { return nil }
        var d = ba - fa
        if closed && d < -total / 2 { d += total }
        return d > 0 && d <= Self.slideMaxM ? d : nil
    }

    /// As apps/api/src/geo.ts.
    static func haversine(_ aLat: Double, _ aLon: Double, _ bLat: Double, _ bLon: Double) -> Double {
        let r = Double.pi / 180
        let s = pow(sin((bLat - aLat) * r / 2), 2) + cos(aLat * r) * cos(bLat * r) * pow(sin((bLon - aLon) * r / 2), 2)
        return 2 * 6_371_000 * asin(min(1, sqrt(s)))
    }

    static func bearing(_ aLat: Double, _ aLon: Double, _ bLat: Double, _ bLon: Double) -> Double {
        let r = Double.pi / 180
        let y = sin((bLon - aLon) * r) * cos(bLat * r)
        let x = cos(aLat * r) * sin(bLat * r) - sin(aLat * r) * cos(bLat * r) * cos((bLon - aLon) * r)
        return ((atan2(y, x) / r).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    }
}

struct CampusMap {
    let stops: [MapStop]
    let routes: [String: MapRoute]
    /// The main campus's stops (not P's trip to the Botanic Gardens).
    let core: Set<String>

    /// The services in pill order: A1, A2, D1, …
    var services: [String] { routes.keys.sorted() }

    func stop(_ code: String) -> MapStop? { stops.first { $0.code == code } }

    /// A service's colour; grey for none, or one the map doesn't know.
    func color(_ svc: String?) -> String { svc.flatMap { routes[$0]?.color } ?? noServiceColor }

    /// Of the stops `codes`, the one nearest (`lat`, `lon`): a click's slop can take in two stops a road apart.
    func nearest(_ codes: [String], lat: Double?, lon: Double?) -> String? {
        var seen = Set<String>()
        let known = codes.filter { seen.insert($0).inserted }.compactMap(stop)
        guard let lat, let lon else { return known.first?.code ?? codes.first }
        let k = cos(lat * .pi / 180)
        return known.min { a, b in
            pow(a.lat - lat, 2) + pow((a.lon - lon) * k, 2) < pow(b.lat - lat, 2) + pow((b.lon - lon) * k, 2)
        }?.code ?? codes.first
    }

    /// [west, south, east, north] of the main campus.
    var coreBounds: [Double] {
        let inCore = stops.filter { core.contains($0.code) }
        let pts = inCore.isEmpty ? stops : inCore
        return [pts.map(\.lon).min()!, pts.map(\.lat).min()!, pts.map(\.lon).max()!, pts.map(\.lat).max()!]
    }

    /// The stops and routes from `/campus`; nil when it isn't that.
    static func parse(_ data: Data) -> CampusMap? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = o["stops"] as? [[String: Any]], let r = o["routes"] as? [String: Any] else { return nil }
        var core = Set<String>()
        let stops: [MapStop] = s.compactMap { x in
            guard let code = x["code"] as? String, let lat = (x["lat"] as? NSNumber)?.doubleValue, let lon = (x["lon"] as? NSNumber)?.doubleValue else { return nil }
            if (x["core"] as? Bool) ?? true { core.insert(code) }
            return MapStop(code: code, name: x["name"] as? String ?? code, lat: lat, lon: lon, services: x["services"] as? [String] ?? [])
        }
        var routes: [String: MapRoute] = [:]
        for (svc, v) in r {
            guard let x = v as? [String: Any] else { continue }
            let line = (x["line"] as? [[Any]] ?? []).compactMap { p -> [Double]? in
                guard p.count >= 2, let lon = (p[0] as? NSNumber)?.doubleValue, let lat = (p[1] as? NSNumber)?.doubleValue else { return nil }
                return [lon, lat]
            }
            if line.count >= 2 { routes[svc] = MapRoute(svc: svc, color: mapColor(x["color"] as? String), line: line, loop: x["loop"] as? Bool ?? false) }
        }
        guard !stops.isEmpty else { return nil }
        return CampusMap(stops: stops, routes: routes, core: core)
    }
}

/// A service without a colour of its own, as on the web and the phone.
let noServiceColor = "#8a939c"

/// "#E53935" -> "#e53935"; grey for anything else.
func mapColor(_ hex: String?) -> String {
    guard let h = hex?.lowercased(), hexRGB(h) != nil else { return noServiceColor }
    return h
}

/// A stretch of a route line, `from` and `to` metres along it, starting at the stop named `last`.
struct Stretch: Hashable {
    let from: Double
    let to: Double
    let last: String
}

/// A bus on the map, as `/buses` gives it: an id stable while it runs, and its
/// number plate. It's at a stop (`at`, drawn at the stop's dot) or between two
/// (drawn on its line); `ox` and `oy` are how far from that point it's drawn,
/// in points at full size, turned with the road: beside the dot at a stop.
struct LiveBus: Hashable {
    let id: String
    var lat: Double
    var lon: Double
    var heading: Double?
    var moving = false
    var crowd: String? = nil
    var nextStop: String? = nil
    /// Metres along its route line of where it's drawn; nil off its line.
    var along: Double? = nil
    /// Its number plate (PD726D).
    var plate: String? = nil
    /// The stop it's at, or nil between stops.
    var at: String? = nil
    /// At a stop, its place among the buses there: 0 in front, then 1, 2 behind.
    var slot = 0
    /// Between stops, the stretch of its line it's somewhere on.
    var stretch: Stretch? = nil
    /// The stops still ahead, the next first, to where its line ends, as the
    /// server walks them; empty past a one-way line's end (or from an older API).
    var upcoming: [String] = []
    /// Where its line ends; nil from an older API.
    var towards: String? = nil
    var ox = 0.0
    var oy = 0.0

    /// As the web map (apps/web/public/app/map.js) and the phone.
    static let atStopSide = 22.0
    static let atStopStep = 26.0

    /// Drawn where it goes: at a stop, beside the dot to its left (the kerb:
    /// buses drive on the left), the ones behind it further back.
    func placed() -> LiveBus {
        var b = self
        if at != nil { b.ox = -Self.atStopSide; b.oy = Self.atStopStep * Double(slot) } else { b.ox = 0; b.oy = 0 }
        return b
    }
}

/// One service's buses, in the feed's order. `available` false: the feed
/// couldn't be reached, which isn't "no buses". `stale`: the feed is down and
/// these are the last places it gave.
struct BusList {
    let svc: String
    let available: Bool
    var stale = false
    let buses: [LiveBus]

    static func parse(_ data: Data) -> BusList? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let svc = o["svc"] as? String else { return nil }
        func num(_ x: Any?) -> Double? { (x as? NSNumber)?.doubleValue }
        func name(_ x: Any?) -> String? { ((x as? [String: Any])?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        let buses: [LiveBus] = (o["buses"] as? [[String: Any]] ?? []).compactMap { b in
            guard let id = b["id"] as? String, let lat = num(b["lat"]), let lon = num(b["lon"]) else { return nil }
            var stretch: Stretch?
            if let st = b["stretch"] as? [String: Any], let from = num(st["from"]), let to = num(st["to"]), let last = name(st["last"]) {
                stretch = Stretch(from: from, to: to, last: last)
            }
            return LiveBus(
                id: id, lat: lat, lon: lon, heading: num(b["heading"]), moving: b["moving"] as? Bool ?? false,
                crowd: (b["crowd"] as? String).flatMap { $0.isEmpty ? nil : $0 }, nextStop: name(b["nextStop"]),
                along: num(b["along"]), plate: (b["plate"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                at: name(b["at"]), slot: (b["slot"] as? Int) ?? 0, stretch: stretch,
                upcoming: (b["upcoming"] as? [Any] ?? []).compactMap(name), towards: name(b["towards"])
            )
        }
        return BusList(svc: svc, available: o["available"] as? Bool ?? false, stale: o["stale"] as? Bool ?? false, buses: buses)
    }
}

/// A stop's board from `/arrivals`. `available` false: no times from the feed.
struct StopBoard {
    let available: Bool
    let rows: [BoardRow]

    static func parse(_ data: Data) -> StopBoard? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let rows: [BoardRow] = (o["board"] as? [[String: Any]] ?? []).compactMap { r in
            guard let svc = r["svc"] as? String, let eta = r["etaS"] as? Int else { return nil }
            return BoardRow(svc: svc, etaS: eta, quality: r["quality"] as? String ?? "", eta: (r["eta"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        }
        return StopBoard(available: o["available"] as? Bool ?? false, rows: rows)
    }
}

/// GeoJSON for the map's sources.
enum MapGeoJson {
    static func routes(_ campus: CampusMap) -> Data {
        collection(campus.routes.values.map { r in
            feature(["type": "LineString", "coordinates": r.line], ["svc": r.svc, "color": r.color])
        })
    }

    /// `services` as " A1 D2 ": spaces round each, so K never matches inside another code.
    static func stops(_ campus: CampusMap) -> Data {
        collection(campus.stops.map { s in
            point(s.lon, s.lat, ["code": s.code, "name": s.name, "services": " \(s.services.joined(separator: " ")) "])
        })
    }

    static func buses(svc: String, color: String, _ buses: [LiveBus]) -> Data {
        collection(buses.map { b in point(b.lon, b.lat, busProperties(svc: svc, color: color, b)) })
    }

    /// A bus's properties, which its icon layers read: the map window sets
    /// them on features directly while a bus slides.
    static func busProperties(svc: String, color: String, _ b: LiveBus) -> [String: Any] {
        ["id": b.id, "svc": svc, "color": color, "heading": b.heading ?? 0, "offset": [b.ox, b.oy]]
    }

    /// A clicked bus's `stretch` of `path`, in the service's `color`; empty when there's none.
    static func stretch(color: String, path: RoutePath?, _ stretch: Stretch?) -> Data {
        guard let stretch, let line = path?.slice(stretch.from, stretch.to) else { return empty }
        return collection([feature(["type": "LineString", "coordinates": line], ["color": color])])
    }

    static func me(lat: Double, lon: Double) -> Data { collection([point(lon, lat, [:])]) }

    static let empty = collection([])

    private static func point(_ lon: Double, _ lat: Double, _ props: [String: Any]) -> [String: Any] {
        feature(["type": "Point", "coordinates": [lon, lat]], props)
    }

    private static func feature(_ geometry: [String: Any], _ props: [String: Any]) -> [String: Any] {
        ["type": "Feature", "geometry": geometry, "properties": props]
    }

    private static func collection(_ features: [[String: Any]]) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["type": "FeatureCollection", "features": features])) ?? Data()
    }
}

/// Each bus's slide from where it was drawn to its new place, along its route
/// line, so it follows the road round corners, easing in and out. It takes
/// `duration(for:)` its distance: further, longer.
/// Its old and new places may be beside the line (a stop's dot, and beside
/// it), so it moves from one to the other as it goes. One that can't get there
/// along the line (behind it, a long way on, no line) jumps, and so does every
/// bus with `still` (Reduce motion) or after a while without an answer.
/// Times are seconds on any one clock that counts sleep (`Slides.clock`).
/// Buses are drawn in the order of the latest answer, the feed's.
struct Slides {
    private struct Slide {
        let from: LiveBus?
        let to: LiveBus
        let start: Double
        let path: RoutePath?
        let d: Double
        var s = 0.0
    }

    private var slides: [String: Slide] = [:]
    private var order: [String] = []
    /// When the last answer came, to tell a stale map.
    private var lastUpdate: Double?
    private let duration: (Double) -> Double

    /// No answer for longer than this: every bus jumps to where it is now.
    static let staleS = 15.0

    init(duration: @escaping (Double) -> Double = Slides.slideS) { self.duration = duration }

    /// How long a slide of `m` metres takes, as the web map and the phone: a
    /// steady 100 m a second, from 1 s for a short hop to 4 s, done before
    /// the next answer (every 5 s).
    static func slideS(_ m: Double) -> Double { min(max(m / 100, 1), 4) }

    /// Seconds on a clock that keeps counting while the Mac sleeps
    /// (CLOCK_MONOTONIC_RAW, mach_continuous_time), so an answer from before
    /// a sleep is seen as stale. `systemUptime` and CLOCK_UPTIME_RAW stop
    /// during sleep; Date() can be set back.
    static var clock: Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1e9 }

    /// New places `buses`, with `path` their route's line, at `now`.
    mutating func update(_ buses: [LiveBus], path: RoutePath?, now: Double, still: Bool = false) {
        // No answer for a while (the Mac slept, the window was closed):
        // every bus jumps to where it is now.
        let stale = lastUpdate.map { now - $0 > Self.staleS } ?? true
        lastUpdate = now
        var next: [String: Slide] = [:]
        var order: [String] = []
        for raw in buses {
            if next[raw.id] == nil { order.append(raw.id) }
            let b = raw.placed()
            let from = slides[b.id].map { at($0, now) }
            if !stale, !still, let from, let path, let d = path.ahead(from: from, to: b) {
                next[b.id] = Slide(from: from, to: b, start: now, path: path, d: d, s: duration(d))
            } else {
                next[b.id] = Slide(from: nil, to: b, start: now, path: nil, d: 0)
            }
        }
        slides = next
        self.order = order
    }

    /// Each bus where it's drawn at `now`.
    func at(_ now: Double) -> [LiveBus] { order.compactMap { slides[$0] }.map { at($0, now) } }

    /// Whether any bus is still on its way at `now`.
    func moving(_ now: Double) -> Bool { slides.values.contains { $0.from != nil && now - $0.start < $0.s } }

    private func at(_ s: Slide, _ now: Double) -> LiveBus {
        let b = s.to
        guard let f = s.from, let path = s.path, let fa = f.along, let ba = b.along else { return b }
        let k = min(max((now - s.start) / s.s, 0), 1)
        if k >= 1 { return b }
        let e = k < 0.5 ? 2 * k * k : 1 - pow(-2 * k + 2, 2) / 2
        let p = path.point(at: fa + s.d * e)
        let pa = path.point(at: fa)
        let pb = path.point(at: ba)
        var out = b
        out.lat = p.lat + (f.lat - pa.lat) * (1 - e) + (b.lat - pb.lat) * e
        out.lon = p.lon + (f.lon - pa.lon) * (1 - e) + (b.lon - pb.lon) * e
        out.along = path.wrap(fa + s.d * e)
        out.heading = p.bearing
        out.ox = f.ox + (b.ox - f.ox) * e
        out.oy = f.oy + (b.oy - f.oy) * e
        return out
    }
}
