import Foundation

struct ProfileDoc: @unchecked Sendable {
    var json: [String: Any]

    init(_ json: [String: Any]) { self.json = json }

    init?(data: Data) {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        json = o
    }

    var data: Data { (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8) }

    struct Limits: Equatable {
        var label = 60
        var places = 12
        var placeLabel = 24
        var homeWalkMin = 0...30
    }

    var limits: Limits {
        var l = Limits()
        guard let o = json["limits"] as? [String: Any] else { return l }
        func n(_ key: String, _ fallback: Int) -> Int { (o[key] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? fallback }
        l.label = n("label", l.label)
        l.places = n("places", l.places)
        l.placeLabel = n("placeLabel", l.placeLabel)
        if let w = o["homeWalkMin"] as? [String: Any] {
            let lo = w["min"] as? Int ?? 0
            let hi = w["max"] as? Int ?? 30
            if hi >= lo { l.homeWalkMin = lo...hi }
        }
        return l
    }

    var homeStops: [String] { (json["home"] as? [String: Any])?["stops"] as? [String] ?? [] }

    mutating func setHomeStops(_ stops: [String]) {
        var unique: [String] = []
        for s in stops where !unique.contains(s) { unique.append(s) }
        json["home"] = unique.isEmpty ? NSNull() : ["stops": Array(unique.prefix(3))]
    }

    var lang: String {
        get { json["lang"] as? String ?? "auto" }
        set { json["lang"] = newValue }
    }

    var clock: String {
        get { json["clock"] as? String ?? "auto" }
        set { json["clock"] = newValue }
    }

    var homeWalkMin: Int {
        get { json["homeWalkMin"] as? Int ?? 5 }
        set { json["homeWalkMin"] = min(max(newValue, limits.homeWalkMin.lowerBound), limits.homeWalkMin.upperBound) }
    }

    var walkPace: String {
        get { json["walkPace"] as? String ?? "normal" }
        set { json["walkPace"] = newValue }
    }

    var preferBus: Bool {
        get { json["preferBus"] as? Bool ?? true }
        set { json["preferBus"] = newValue }
    }

    var fullBusMargin: Bool {
        get { json["fullBusMargin"] as? Bool ?? true }
        set { json["fullBusMargin"] = newValue }
    }

    var publicBuses: Bool {
        get { json["publicBuses"] as? Bool ?? false }
        set { json["publicBuses"] = newValue }
    }

    var gapHours: Double {
        get { (json["gapHours"] as? NSNumber)?.doubleValue ?? 2 }
        set { json["gapHours"] = min(max(newValue, 0.5), 12) }
    }

    var dayStartMin: Int {
        get { json["dayStartMin"] as? Int ?? 6 * 60 }
        set { json["dayStartMin"] = newValue }
    }

    var dayEndMin: Int {
        get { json["dayEndMin"] as? Int ?? 18 * 60 }
        set { json["dayEndMin"] = newValue }
    }

    var share: String? { (json["share"] as? String).flatMap { $0.isEmpty ? nil : $0 } }

    var trips: [ProfileTrip] { list("trips").map(ProfileTrip.init) }
    var manual: [ProfileTrip] { list("manual").map(ProfileTrip.init) }

    var classes: [ClassEntry] {
        let all =
            trips.enumerated().map { ClassEntry(imported: true, index: $0.offset, trip: $0.element) }
            + manual.enumerated().map { ClassEntry(imported: false, index: $0.offset, trip: $0.element) }
        return all.sorted {
            let a = weekOrder($0.trip.day)
            let b = weekOrder($1.trip.day)
            return a != b ? a < b : $0.trip.arriveByMin < $1.trip.arriveByMin
        }
    }

    mutating func addManual(_ t: ProfileTrip) {
        json["manual"] = list("manual") + [t.json]
    }

    mutating func setClassStop(_ c: ClassEntry, to: String) {
        let key = c.imported ? "trips" : "manual"
        var l = list(key)
        guard let i = find(c, in: l) else { return }
        l[i]["to"] = to
        json[key] = l
    }

    mutating func removeClass(_ c: ClassEntry) {
        let key = c.imported ? "trips" : "manual"
        var l = list(key)
        guard let i = find(c, in: l) else { return }
        l.remove(at: i)
        json[key] = l
    }

    private(set) var missed = false

    private mutating func find(_ c: ClassEntry, in l: [[String: Any]]) -> Int? {
        func same(_ o: [String: Any]) -> Bool {
            var t = ProfileTrip(o)
            t.to = c.trip.to
            return t == c.trip
        }
        if l.indices.contains(c.index), same(l[c.index]) { return c.index }
        if let i = l.firstIndex(where: same) { return i }
        missed = true
        return nil
    }

    var places: [SavedPlace] {
        list("places").compactMap { p in
            guard let key = p["key"] as? String, let label = p["label"] as? String, let to = p["to"] as? String else { return nil }
            return SavedPlace(key: key, label: label, to: to)
        }
    }

    mutating func addPlace(label: String, to: String) {
        let name = clippedUTF16(label.trimmingCharacters(in: .whitespaces), limits.placeLabel)
        let p: [String: Any] = ["key": placeKey(name, taken: places.map(\.key)), "label": name, "to": to]
        json["places"] = list("places") + [p]
    }

    mutating func removePlace(key: String) -> RemovedPlace? {
        let all = list("places")
        guard let i = all.firstIndex(where: { $0["key"] as? String == key }) else { return nil }
        var rest = all
        rest.remove(at: i)
        json["places"] = rest
        let usual = list("usual")
        if json["usual"] != nil { json["usual"] = usual.filter { $0["place"] as? String != key } }
        return RemovedPlace(index: i, place: all[i], usual: usual.filter { $0["place"] as? String == key })
    }

    mutating func restorePlace(_ r: RemovedPlace) {
        let now = places
        let to = r.place["to"] as? String
        let key = r.place["key"] as? String
        if now.count >= limits.places || now.contains(where: { $0.to == to || $0.key == key }) { return }
        var all = list("places")
        all.insert(r.place, at: min(r.index, all.count))
        json["places"] = all
        if !r.usual.isEmpty { json["usual"] = list("usual") + r.usual }
    }

    var usual: [UsualTime] {
        list("usual").compactMap { u in
            guard let place = u["place"] as? String, let day = u["day"] as? Int, let at = u["atMin"] as? Int else { return nil }
            return UsualTime(place: place, day: day, atMin: at)
        }
    }

    mutating func removeUsual(_ u: UsualTime) {
        json["usual"] = list("usual").filter {
            !($0["place"] as? String == u.place && $0["day"] as? Int == u.day && $0["atMin"] as? Int == u.atMin)
        }
    }

    private func list(_ key: String) -> [[String: Any]] { json[key] as? [[String: Any]] ?? [] }
}

struct ProfileTrip: Hashable, Sendable {
    var day: Int
    var arriveByMin: Int
    var endMin: Int?
    var to: String
    var label: String
    var venue: String

    init(day: Int, arriveByMin: Int, endMin: Int?, to: String, label: String, venue: String) {
        self.day = day
        self.arriveByMin = arriveByMin
        self.endMin = endMin
        self.to = to
        self.label = label
        self.venue = venue
    }

    init(_ o: [String: Any]) {
        day = o["day"] as? Int ?? 1
        arriveByMin = o["arriveByMin"] as? Int ?? 0
        endMin = o["endMin"] as? Int
        to = o["to"] as? String ?? ""
        label = o["label"] as? String ?? ""
        venue = o["venue"] as? String ?? ""
    }

    var json: [String: Any] {
        var o: [String: Any] = ["day": day, "arriveByMin": arriveByMin, "to": to, "label": label, "venue": venue]
        if let endMin { o["endMin"] = endMin }
        return o
    }
}

struct ClassEntry: Identifiable, Hashable, Sendable {
    let imported: Bool
    let index: Int
    let trip: ProfileTrip
    var id: String { "\(imported ? "t" : "m")\(index)" }
}

struct SavedPlace: Hashable, Identifiable, Sendable {
    let key: String
    let label: String
    let to: String
    var id: String { key }
}

struct UsualTime: Hashable, Sendable {
    let place: String
    let day: Int
    let atMin: Int
}

struct RemovedPlace: @unchecked Sendable {
    let index: Int
    let place: [String: Any]
    let usual: [[String: Any]]
    var label: String { place["label"] as? String ?? "" }
}

func clippedUTF16(_ s: String, _ limit: Int) -> String {
    guard s.utf16.count > limit else { return s }
    var n = 0
    return String(
        s.prefix { c in
            n += c.utf16.count
            return n <= limit
        })
}

func placeKey(_ label: String, taken: [String]) -> String {
    let slug = label.lowercased()
        .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    var key = String(slug.prefix(24))
    if key.isEmpty { key = "place" }
    let base = String(key.prefix(21))
    var n = 2
    while taken.contains(key) {
        key = "\(base)-\(n)"
        n += 1
    }
    return key
}

let mondayFirst = [1, 2, 3, 4, 5, 6, 0]

private func weekOrder(_ day: Int) -> Int { mondayFirst.firstIndex(of: day) ?? 7 }
