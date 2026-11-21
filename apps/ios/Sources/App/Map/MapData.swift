import Foundation

enum PanLimit {
    static let extent = [103.755, 1.28, 103.83, 1.332]
    private static let tile = 512.0

    static func minZoom(width: Double, height: Double) -> Double {
        max(log2(width / (tile * (x(extent[2]) - x(extent[0])))), log2(height / (tile * (y(extent[1]) - y(extent[3])))))
    }

    static func centre(width: Double, height: Double, zoom: Double, left: Double = 0, bottom: Double = 0) -> [Double] {
        let world = tile * pow(2, zoom)
        var (west, east) = inset(x(extent[0]), x(extent[2]), by: width / 2 / world)
        var (top, south) = inset(y(extent[3]), y(extent[1]), by: height / 2 / world)
        west -= left / world
        south += bottom / world
        return [lon(west), lat(south), lon(east), lat(top)]
    }

    private static func inset(_ a: Double, _ b: Double, by: Double) -> (Double, Double) {
        b - a > 2 * by ? (a + by, b - by) : ((a + b) / 2, (a + b) / 2)
    }

    private static func x(_ lon: Double) -> Double { (lon + 180) / 360 }
    private static func y(_ lat: Double) -> Double { (1 - log(tan(.pi / 4 + lat * .pi / 360)) / .pi) / 2 }
    private static func lon(_ x: Double) -> Double { x * 360 - 180 }
    private static func lat(_ y: Double) -> Double { atan(sinh(.pi * (1 - 2 * y))) * 180 / .pi }
}

struct MapStop: Hashable {
    let code: String
    let name: String
    let lat: Double
    let lon: Double
    let services: [String]
    var longName: String? = nil
}

struct MapRoute {
    let svc: String
    let color: String
    let line: [[Double]]
    let loop: Bool
    let seq: [String]
    let path: RoutePath

    init(svc: String, color: String, line: [[Double]], loop: Bool = false, seq: [String] = []) {
        self.svc = svc
        self.color = color
        self.line = line
        self.loop = loop
        self.seq = seq
        path = RoutePath(line, loop: loop)
    }

    var bounds: [Double] {
        [line.map { $0[0] }.min()!, line.map { $0[1] }.min()!, line.map { $0[0] }.max()!, line.map { $0[1] }.max()!]
    }
}

struct RoutePath {
    private let line: [[Double]]
    private let cum: [Double]
    let total: Double
    let closed: Bool

    static let slideMaxM = 1_500.0

    init(_ line: [[Double]], loop: Bool = false) {
        self.line = line
        var c = [Double](repeating: 0, count: line.count)
        for i in line.indices.dropFirst() { c[i] = c[i - 1] + Self.haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]) }
        cum = c
        total = c.last ?? 0
        closed = loop && line.count >= 2
    }

    func point(at m: Double) -> (lat: Double, lon: Double, bearing: Double) {
        let at = wrap(m)
        var lo = 0
        var hi = cum.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if cum[mid] <= at { lo = mid } else { hi = mid }
        }
        let a = line[lo]
        let b = line[hi]
        let seg = cum[hi] - cum[lo]
        let t = seg > 0 ? (at - cum[lo]) / seg : 0
        return (a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t, Self.bearing(a[1], a[0], b[1], b[0]))
    }

    func slice(_ a: Double, _ b: Double) -> [[Double]]? {
        guard line.count >= 2, b > a, a >= 0, b <= total + 1 else { return nil }
        func end(_ m: Double) -> [Double] {
            let p = point(at: min(m, total))
            return [p.lon, p.lat]
        }
        return [end(a)] + line.indices.filter { cum[$0] > a && cum[$0] < b }.map { line[$0] } + [end(b)]
    }

    func wrap(_ m: Double) -> Double {
        guard total > 0 else { return 0 }
        return closed ? (m.truncatingRemainder(dividingBy: total) + total).truncatingRemainder(dividingBy: total) : min(max(m, 0), total)
    }

    func ahead(from f: LiveBus, to b: LiveBus) -> Double? {
        guard let fa = f.along, let ba = b.along, line.count >= 2, total > 0, fa <= total + 1, ba <= total + 1 else { return nil }
        var d = ba - fa
        if closed && d < -total / 2 { d += total }
        return d > 0 && d <= Self.slideMaxM ? d : nil
    }

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
    let core: Set<String>

    var services: [String] { routes.keys.sorted() }

    func stop(_ code: String) -> MapStop? { stops.first { $0.code == code } }

    func color(_ svc: String?) -> String { svc.flatMap { routes[$0]?.color } ?? noServiceColor }

    func nearest(_ codes: [String], lat: Double?, lon: Double?) -> String? {
        var seen = Set<String>()
        let known = codes.filter { seen.insert($0).inserted }.compactMap(stop)
        guard let lat, let lon else { return known.first?.code ?? codes.first }
        let k = cos(lat * .pi / 180)
        return known.min { a, b in
            pow(a.lat - lat, 2) + pow((a.lon - lon) * k, 2) < pow(b.lat - lat, 2) + pow((b.lon - lon) * k, 2)
        }?.code ?? codes.first
    }

    var coreBounds: [Double] {
        let inCore = stops.filter { core.contains($0.code) }
        var pts = (inCore.isEmpty ? stops : inCore).map { [$0.lon, $0.lat] }
        if !inCore.isEmpty {
            for r in routes.values where !r.seq.isEmpty && r.seq.allSatisfy(core.contains) { pts += r.line }
        }
        return [pts.map { $0[0] }.min()!, pts.map { $0[1] }.min()!, pts.map { $0[0] }.max()!, pts.map { $0[1] }.max()!]
    }

    static func parse(_ data: Data) -> CampusMap? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let s = o["stops"] as? [[String: Any]], let r = o["routes"] as? [String: Any]
        else { return nil }
        var core = Set<String>()
        let stops: [MapStop] = s.compactMap { x in
            guard let code = x["code"] as? String, let lat = (x["lat"] as? NSNumber)?.doubleValue,
                let lon = (x["lon"] as? NSNumber)?.doubleValue
            else { return nil }
            if (x["core"] as? Bool) ?? true { core.insert(code) }
            return MapStop(
                code: code, name: x["name"] as? String ?? code, lat: lat, lon: lon, services: x["services"] as? [String] ?? [],
                longName: (x["longName"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        }
        var routes: [String: MapRoute] = [:]
        for (svc, v) in r {
            guard let x = v as? [String: Any] else { continue }
            let line = (x["line"] as? [[Any]] ?? []).compactMap { p -> [Double]? in
                guard p.count >= 2, let lon = (p[0] as? NSNumber)?.doubleValue, let lat = (p[1] as? NSNumber)?.doubleValue else {
                    return nil
                }
                return [lon, lat]
            }
            if line.count >= 2 {
                routes[svc] = MapRoute(
                    svc: svc, color: mapColor(x["color"] as? String), line: line, loop: x["loop"] as? Bool ?? false,
                    seq: x["seq"] as? [String] ?? [])
            }
        }
        guard !stops.isEmpty else { return nil }
        return CampusMap(stops: stops, routes: routes, core: core)
    }
}

let noServiceColor = "#8a939c"

func mapColor(_ hex: String?) -> String {
    guard let h = hex?.lowercased(), hexRGB(h) != nil else { return noServiceColor }
    return h
}

struct Stretch: Hashable {
    let from: Double
    let to: Double
    let last: String
}

struct LiveBus: Hashable {
    let id: String
    var lat: Double
    var lon: Double
    var heading: Double?
    var moving = false
    var crowd: String? = nil
    var nextStop: String? = nil
    var along: Double? = nil
    var plate: String? = nil
    var at: String? = nil
    var slot = 0
    var stretch: Stretch? = nil
    var upcoming: [String] = []
    var towards: String? = nil
    var atCode: String? = nil
    var nextStopCode: String? = nil
    var passedCode: String? = nil
    var upcomingCodes: [String?] = []
    var ox = 0.0
    var oy = 0.0

    static let atStopSide = 22.0
    static let atStopStep = 26.0

    func placed() -> LiveBus {
        var b = self
        if at != nil {
            b.ox = -Self.atStopSide
            b.oy = Self.atStopStep * Double(slot)
        } else {
            b.ox = 0
            b.oy = 0
        }
        return b
    }
}

struct BusList {
    let svc: String
    let available: Bool
    var stale = false
    let buses: [LiveBus]

    static func parse(_ data: Data) -> BusList? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let svc = o["svc"] as? String else { return nil }
        func num(_ x: Any?) -> Double? { (x as? NSNumber)?.doubleValue }
        func name(_ x: Any?) -> String? { ((x as? [String: Any])?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        func code(_ x: Any?) -> String? { ((x as? [String: Any])?["code"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
        let buses: [LiveBus] = (o["buses"] as? [[String: Any]] ?? []).compactMap { b in
            guard let id = b["id"] as? String, let lat = num(b["lat"]), let lon = num(b["lon"]) else { return nil }
            var stretch: Stretch?
            if let st = b["stretch"] as? [String: Any], let from = num(st["from"]), let to = num(st["to"]), let last = name(st["last"]) {
                stretch = Stretch(from: from, to: to, last: last)
            }
            let ahead = (b["upcoming"] as? [Any] ?? []).filter { name($0) != nil }
            return LiveBus(
                id: id, lat: lat, lon: lon, heading: num(b["heading"]), moving: b["moving"] as? Bool ?? false,
                crowd: (b["crowd"] as? String).flatMap { $0.isEmpty ? nil : $0 }, nextStop: name(b["nextStop"]),
                along: num(b["along"]), plate: (b["plate"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                at: name(b["at"]), slot: (b["slot"] as? Int) ?? 0, stretch: stretch,
                upcoming: ahead.compactMap(name), towards: name(b["towards"]),
                atCode: code(b["at"]), nextStopCode: code(b["nextStop"]),
                passedCode: stretch == nil ? nil : code((b["stretch"] as? [String: Any])?["last"]),
                upcomingCodes: ahead.map(code)
            )
        }
        return BusList(svc: svc, available: o["available"] as? Bool ?? false, stale: o["stale"] as? Bool ?? false, buses: buses)
    }
}

struct BusStrip: Equatable {
    var passed: String?
    var here: String?
    var next: String?
    var after: [String]
    var more: Int
    var passedCode: String? = nil
    var hereCode: String? = nil
    var nextCode: String? = nil
    var afterCodes: [String?] = []

    static let afterMax = 4

    var between: Bool { here == nil }

    var any: Bool { next != nil }

    static func of(_ bus: LiveBus, all: Bool = false) -> BusStrip {
        let ahead = bus.upcoming.isEmpty ? (bus.nextStop.map { [$0] } ?? []) : bus.upcoming
        let codes: [String?] =
            bus.upcoming.isEmpty
            ? (bus.nextStop == nil ? [] : [bus.nextStopCode])
            : ahead.indices.map { bus.upcomingCodes.indices.contains($0) ? bus.upcomingCodes[$0] : nil }
        let rest = Array(ahead.dropFirst())
        let shown = all ? rest.count : min(rest.count, afterMax)
        return BusStrip(
            passed: bus.at == nil ? bus.stretch?.last : nil,
            here: bus.at,
            next: ahead.first,
            after: Array(rest.prefix(shown)),
            more: rest.count - shown,
            passedCode: bus.at == nil ? bus.passedCode : nil,
            hereCode: bus.atCode,
            nextCode: codes.first ?? nil,
            afterCodes: Array(codes.dropFirst().prefix(shown))
        )
    }
}

enum MapGeoJson {
    static func routes(_ campus: CampusMap) -> Data {
        collection(
            campus.routes.values.sorted { $0.svc < $1.svc }.map { r in
                feature(["type": "LineString", "coordinates": r.line], ["svc": r.svc, "color": r.color])
            })
    }

    static func stops(_ campus: CampusMap) -> Data {
        collection(
            campus.stops.map { s in
                point(s.lon, s.lat, ["code": s.code, "name": s.name, "services": " \(s.services.joined(separator: " ")) "])
            })
    }

    static func buses(svc: String, color: String, _ buses: [LiveBus]) -> Data {
        collection(buses.map { b in point(b.lon, b.lat, busProperties(svc: svc, color: color, b)) })
    }

    static func busProperties(svc: String, color: String, _ b: LiveBus) -> [String: Any] {
        ["id": b.id, "svc": svc, "color": color, "heading": b.heading ?? 0, "offset": [b.ox, b.oy]]
    }

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
    private var lastUpdate: Double?
    private let duration: (Double) -> Double

    static let staleS = 15.0

    init(duration: @escaping (Double) -> Double = Slides.slideS) { self.duration = duration }

    static func slideS(_ m: Double) -> Double { min(max(m / 100, 1), 4) }

    static var clock: Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1e9 }

    mutating func update(_ buses: [LiveBus], path: RoutePath?, now: Double, still: Bool = false) {
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

    func at(_ now: Double) -> [LiveBus] { order.compactMap { slides[$0] }.map { at($0, now) } }

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
