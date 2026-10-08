import Foundation
import Testing
@testable import Terminus

/// The map window's data, from replies shaped like the API's (see its /campus
/// and /buses tests). The same cases as the phone's MapDataTest.

private let campusJson = Data("""
{"stops": [
  {"code": "COM3", "name": "COM 3", "lat": 1.2948, "lon": 103.7745, "services": ["D1", "D2"], "core": true},
  {"code": "BG-MRT", "name": "Botanic Gdns MRT", "lat": 1.3224, "lon": 103.8153, "services": ["P"], "core": false}
 ],
 "routes": {
  "D2": {"seq": ["COM3"], "loop": true, "color": "#8e44c9", "line": [[103.7745, 1.2948], [103.7750, 1.2950], [103.7760, 1.2955]], "shaped": true},
  "A1": {"seq": ["COM3"], "loop": true, "color": "#e53935", "line": [[103.77, 1.29], [103.78, 1.30]], "shaped": true},
  "X": {"seq": [], "loop": false, "color": "nope", "line": [], "shaped": false}
 }}
""".utf8)

private func json(_ data: Data) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func features(_ data: Data) throws -> [[String: Any]] {
    try #require(json(data)["features"] as? [[String: Any]])
}

private func near(_ a: Double?, _ b: Double, _ tolerance: Double = 1e-9) -> Bool {
    guard let a else { return false }
    return abs(a - b) <= tolerance
}

/// A bus `m` metres along `path`.
private func bus(_ path: RoutePath, _ m: Double, id: String = "b1", heading: Double = 0) -> LiveBus {
    let p = path.point(at: m)
    return LiveBus(id: id, lat: p.lat, lon: p.lon, heading: heading, moving: true, along: m)
}

@Test func campusParsesStopsRoutesAndColours() throws {
    let campus = try #require(CampusMap.parse(campusJson))
    #expect(campus.services == ["A1", "D2"])
    #expect(campus.routes["D2"]?.color == "#8e44c9")
    #expect(campus.stop("COM3")?.services == ["D1", "D2"])
    #expect(campus.core == ["COM3"], "only the main campus's stops")
    let b = try #require(campus.routes["D2"]).bounds
    #expect(near(b[0], 103.7745))
    #expect(near(b[3], 1.2955))
}

@Test func aClickTakingInTwoStopsOpensTheNearer() throws {
    let campus = try #require(CampusMap.parse(campusJson))
    #expect(campus.nearest(["COM3", "BG-MRT"], lat: 1.3220, lon: 103.8150) == "BG-MRT")
    #expect(campus.nearest(["BG-MRT", "COM3"], lat: 1.2950, lon: 103.7746) == "COM3")
    #expect(campus.nearest(["COM3", "BG-MRT"], lat: nil, lon: nil) == "COM3", "without a position, the first")
    #expect(campus.nearest([], lat: 1, lon: 103) == nil)
}

@Test func badColoursAreGrey() {
    #expect(mapColor("nope") == "#8a939c")
    #expect(mapColor(nil) == "#8a939c")
    #expect(mapColor("#D9A000") == "#d9a000")
}

@Test func busesParseWithoutPlates() throws {
    let list = try #require(BusList.parse(Data("""
    {"svc": "D2", "color": "#8e44c9", "available": true, "stale": false, "asOf": "2026-10-02T01:00:00Z",
     "buses": [
       {"id": "3f9a1c0b7e21", "lat": 1.295, "lon": 103.775, "heading": 92, "moving": true, "crowd": "high", "nextStop": {"code": "COM3", "name": "COM 3"}},
       {"id": "aa", "lat": 1.3, "lon": 103.76, "heading": null, "moving": false, "crowd": null, "nextStop": null}
     ]}
    """.utf8)))
    #expect(list.available)
    #expect(list.buses[0].nextStop == "COM 3")
    #expect(list.buses[0].crowd == "high")
    #expect(list.buses[1].heading == nil)
    #expect(list.buses[1].crowd == nil)
    #expect(list.buses[1].nextStop == nil)
    #expect(BusList.parse(Data(#"{"svc": "K", "available": false, "buses": []}"#.utf8))?.available == false)
}

@Test func boardDropsRowsWithNoTime() throws {
    let b = try #require(StopBoard.parse(Data(#"{"available": true, "board": [{"svc": "D2", "etaS": 240, "quality": "live"}, {"svc": "D1", "etaS": null, "quality": "none"}]}"#.utf8)))
    #expect(b.rows.map(\.svc) == ["D2"])
}

@Test func geoJsonForTheMap() throws {
    let campus = try #require(CampusMap.parse(campusJson))
    let stops = try features(MapGeoJson.stops(campus))
    let com3 = try #require(stops.first { ($0["properties"] as? [String: Any])?["code"] as? String == "COM3" })
    #expect((com3["properties"] as? [String: Any])?["services"] as? String == " D1 D2 ")
    #expect(try features(MapGeoJson.routes(campus)).count == 2)
    let placed = LiveBus(id: "b1", lat: 1, lon: 103, heading: nil, moving: true, at: "COM 3", slot: 1).placed()
    let props = try #require(try features(MapGeoJson.buses(svc: "D2", color: "#8e44c9", [placed]))[0]["properties"] as? [String: Any])
    #expect(props["color"] as? String == "#8e44c9")
    #expect(props["heading"] as? Double == 0)
    let offset = try #require(props["offset"] as? [Double])
    #expect(offset[0] == -LiveBus.atStopSide, "at a stop: beside the dot, to its left")
    #expect(offset[1] == LiveBus.atStopStep, "second in line: one bus further back")
}

@Test func busesSlideAlongTheirLineRoundACorner() throws {
    // East, then north: an L with its corner at (103.001, 1.0).
    let path = RoutePath([[103.0, 1.0], [103.001, 1.0], [103.001, 1.001]])
    let leg = RoutePath.haversine(1.0, 103.0, 1.0, 103.001)
    var s = Slides(duration: { _ in 1 })
    s.update([bus(path, leg - 50)], path: path, now: 0)
    #expect(near(s.at(0)[0].along, leg - 50), "a new bus appears where it is")
    s.update([bus(path, leg + 50), bus(path, 10, id: "new")], path: path, now: 0)
    let half = try #require(s.at(0.5).first { $0.id == "b1" })
    #expect(near(half.lat, 1.0), "halfway, at the corner, not cutting it")
    #expect(near(half.lon, 103.001))
    #expect(s.moving(0.5))
    #expect(!s.moving(1))
    let end = try #require(s.at(1).first { $0.id == "b1" })
    #expect(near(end.along, leg + 50))
    #expect(near(end.heading, 0, 1e-6), "pointing along the road")
    // Eased: slower at the ends than in the middle.
    #expect(try #require(s.at(0.1).first { $0.id == "b1" }?.along) - (leg - 50) < 10)
}

@Test func busesSlideBesideTheDotAtAStop() throws {
    // A straight line east, about 1.1 km; a stop's dot 10 m north of it at 500 m.
    let path = RoutePath([[103.0, 1.0], [103.01, 1.0]])
    var between = bus(path, 300, heading: 90)
    between.nextStop = "COM 3"
    var atStop = between
    atStop.lat = path.point(at: 500).lat + 10 / 110_574.0
    atStop.lon = path.point(at: 500).lon
    atStop.along = 500
    atStop.at = "COM 3"
    var s = Slides(duration: { _ in 1 })
    s.update([between], path: path, now: 0)
    s.update([atStop], path: path, now: 2)
    let half = s.at(2.5)[0]
    #expect(near(half.along, 400, 1e-6))
    #expect(near(half.ox, -LiveBus.atStopSide / 2), "halfway beside it")
    let there = s.at(3)[0]
    #expect(near(there.lat, atStop.lat, 1e-12), "at the dot")
    #expect(there.ox == -LiveBus.atStopSide)
    // Behind where it's drawn (the other side of the road, or put right): it jumps.
    s.update([between], path: path, now: 4)
    #expect(near(s.at(4)[0].along, 300))
    #expect(!s.moving(4))
    // Reduce motion: it jumps.
    s.update([atStop], path: path, now: 5, still: true)
    #expect(near(s.at(5)[0].along, 500))
    // No answer for 20 s (the Mac slept): it jumps.
    var later = atStop
    later.along = 700
    later.at = nil
    s.update([later], path: path, now: 25)
    #expect(near(s.at(25)[0].along, 700))
    // A long way on (over 1.5 km), or on a line kept from before the route changed: it jumps.
    var far = atStop
    far.along = 2_000
    #expect(path.ahead(from: between, to: far) == nil)
    far.along = 5_000
    #expect(path.ahead(from: between, to: far) == nil)
}

@Test func aLoopWhoseEndsDoNotMeetStillSlidesOnPastItsStart() throws {
    // Like A1 at KRB: out east about 1.1 km, then back west on the other
    // side of the road, ending some 40 m from where it started. The loop
    // comes from /campus, not from where the line ends.
    let campus = try #require(CampusMap.parse(Data("""
    {"stops": [{"code": "KRB", "name": "KRB", "lat": 1.0, "lon": 103.0}], "routes": {
      "A1": {"seq": ["KRB"], "loop": true, "line": [[103.0, 1.0], [103.01, 1.0], [103.01, 1.0004], [103.0, 1.0004]]},
      "K": {"seq": ["PGP"], "loop": false, "line": [[103.0, 1.0], [103.01, 1.0], [103.01, 1.0004], [103.0, 1.0004]]}}}
    """.utf8)))
    let loop = try #require(campus.routes["A1"]?.path)
    let a = loop.point(at: 0)
    let z = loop.point(at: loop.total - 1e-9)
    #expect(RoutePath.haversine(a.lat, a.lon, z.lat, z.lon) > 40, "the ends are apart")
    #expect(loop.closed)
    let (end, start) = (bus(loop, loop.total - 20), bus(loop, 30))
    #expect(near(loop.ahead(from: end, to: start), 50, 1e-6), "on round past the start, not back")
    var s = Slides(duration: { _ in 1 })
    s.update([end], path: loop, now: 0)
    s.update([start], path: loop, now: 5)
    #expect(s.moving(5.5))
    #expect(near(s.at(5.5)[0].along, 5, 1e-6), "half way, at its start")
    // A line that doesn't loop: back at the start, it jumps.
    let oneWay = try #require(campus.routes["K"]?.path)
    #expect(!oneWay.closed)
    #expect(oneWay.ahead(from: bus(oneWay, oneWay.total - 20), to: bus(oneWay, 30)) == nil)
}

@Test func aLongerSlideTakesLonger() {
    #expect(Slides.slideS(30) == 1)
    #expect(Slides.slideS(210) == 2.1)
    #expect(Slides.slideS(1_400) == 4, "done before the next answer")
    let path = RoutePath([[103.0, 1.0], [103.01, 1.0]])
    var s = Slides()
    s.update([bus(path, 0, heading: 90)], path: path, now: 0)
    s.update([bus(path, 200, heading: 90)], path: path, now: 1)
    #expect(s.moving(2.9))
    #expect(!s.moving(3))
}

@Test func busesSayWhichStopTheyAreAt() throws {
    let list = try #require(BusList.parse(Data("""
    {"svc": "D2", "available": true, "buses": [
      {"id": "a", "plate": "PD726D", "lat": 1.0, "lon": 103.0, "along": 812.5, "heading": 90, "moving": true, "crowd": null, "at": {"code": "COM3", "name": "COM 3"}, "slot": 1, "stretch": null, "nextStop": {"code": "BIZ2", "name": "BIZ 2"}, "upcoming": [{"code": "BIZ2", "name": "BIZ 2"}, {"code": "", "name": ""}, {"code": "PGP", "name": "Prince George's Park"}], "towards": {"code": "PGP", "name": "Prince George's Park"}},
      {"id": "b", "lat": 1.0, "lon": 103.0, "along": 900, "heading": 90, "moving": true, "crowd": null, "at": null, "slot": 0, "stretch": {"from": 812.5, "to": 1100, "last": {"code": "COM3", "name": "COM 3"}}, "nextStop": null}]}
    """.utf8)))
    #expect(list.buses[0].at == "COM 3")
    #expect(list.buses[0].slot == 1)
    #expect(list.buses[0].plate == "PD726D")
    #expect(list.buses[1].at == nil)
    #expect(list.buses[1].plate == nil, "an older API: no plate")
    #expect(list.buses[0].stretch == nil, "at a stop: no stretch")
    #expect(list.buses[1].stretch == Stretch(from: 812.5, to: 1100, last: "COM 3"))
    #expect(list.buses[0].upcoming == ["BIZ 2", "Prince George's Park"], "the stops ahead, next first; a nameless one dropped")
    #expect(list.buses[0].towards == "Prince George's Park")
    #expect(list.buses[1].upcoming == [], "an older API: no stops ahead")
    #expect(list.buses[1].towards == nil)
    let end = try #require(BusList.parse(Data(#"{"svc": "A1", "available": true, "buses": [{"id": "c", "lat": 1.0, "lon": 103.0, "upcoming": [], "towards": {"code": "KR-MRT", "name": "KR MRT"}}]}"#.utf8)))
    #expect(end.buses[0].upcoming == [], "past a one-way line's end")
    #expect(end.buses[0].towards == "KR MRT")
}

@Test func aClickedBusShowsTheStretchItIsOn() throws {
    // East, then north: an L with its corner at (103.001, 1.0).
    let path = RoutePath([[103.0, 1.0], [103.001, 1.0], [103.001, 1.001]])
    let leg = RoutePath.haversine(1.0, 103.0, 1.0, 103.001)
    let line = try #require(path.slice(leg - 20, leg + 30))
    #expect(line.count == 3, "from its start, round the corner, to its end")
    #expect(near(line[1][0], 103.001, 1e-12))
    #expect(near(line[2][0], path.point(at: leg + 30).lon, 1e-12))
    #expect(near(line[2][1], path.point(at: leg + 30).lat, 1e-12))
    #expect(path.slice(10, 20)?.count == 2, "a straight piece: just its ends")
    #expect(path.slice(20, 10) == nil, "not a stretch of this line")
    #expect(path.slice(10, path.total + 500) == nil)
    let geo = try features(MapGeoJson.stretch(color: "#8e44c9", path: path, Stretch(from: leg - 20, to: leg + 30, last: "COM 3")))[0]
    #expect((geo["properties"] as? [String: Any])?["color"] as? String == "#8e44c9")
    #expect(((geo["geometry"] as? [String: Any])?["coordinates"] as? [Any])?.count == 3)
    #expect(MapGeoJson.stretch(color: "#8e44c9", path: path, nil) == MapGeoJson.empty, "no stretch, nothing drawn")
    #expect(MapGeoJson.stretch(color: "#8e44c9", path: nil, Stretch(from: 0, to: 10, last: "COM 3")) == MapGeoJson.empty)
}

@Test func busesSayHowFarAlongTheirLineTheyAre() throws {
    let list = try #require(BusList.parse(Data("""
    {"svc": "D2", "available": true, "buses": [
      {"id": "a", "lat": 1.0, "lon": 103.0, "along": 812.5, "heading": 90, "moving": true, "crowd": null, "nextStop": null},
      {"id": "b", "lat": 1.0, "lon": 103.0, "along": null, "heading": null, "moving": false, "crowd": null, "nextStop": null}]}
    """.utf8)))
    #expect(list.buses[0].along == 812.5)
    #expect(list.buses[1].along == nil)
}

@Test func theStyleReadsTheMapFileFromDisk() throws {
    let style = try json(Data(#"{"version": 8, "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://terminus.rcn.sh/map/campus.pmtiles"}}, "layers": []}"#.utf8))
    let local = MapFiles.localTiles(style, path: "/Users/me/Library/Application Support/sh.rcn.terminus/map/campus.pmtiles")
    let src = (local["sources"] as? [String: Any])?["protomaps"] as? [String: Any]
    #expect(src?["url"] as? String == "pmtiles://file:///Users/me/Library/Application%20Support/sh.rcn.terminus/map/campus.pmtiles")
}

@Test func withoutTheMapFileOnlyTheBackgroundStays() throws {
    let style = try json(Data("""
    {"version": 8, "glyphs": "g", "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://x/map/campus.pmtiles"}},
     "layers": [{"id": "background", "type": "background"}, {"id": "roads", "type": "line", "source": "protomaps"}]}
    """.utf8))
    let plain = MapFiles.withoutBaseMap(style)
    #expect((plain["sources"] as? [String: Any])?.isEmpty == true)
    #expect((plain["layers"] as? [Any])?.count == 1)
    #expect(plain["glyphs"] as? String == "g")
}

@Test func lastKnownBusesAreMarkedStale() throws {
    let list = try #require(BusList.parse(Data(#"{"svc": "D2", "available": true, "stale": true, "buses": [{"id": "a", "lat": 1.3, "lon": 103.77}]}"#.utf8)))
    #expect(list.stale)
    #expect(list.buses.count == 1)
    #expect(BusList.parse(Data(#"{"svc": "D2", "available": true, "buses": []}"#.utf8))?.stale == false, "an older server's answer is fresh")
}

@Test func busesAreDrawnInTheFeedsOrder() {
    let path = RoutePath([[103.0, 1.0], [103.01, 1.0]])
    let ids = ["k", "c", "x", "a", "q", "m", "b"]
    var s = Slides(duration: { _ in 1 })
    s.update(ids.enumerated().map { bus(path, Double($0.offset) * 100, id: $0.element) }, path: path, now: 0)
    #expect(s.at(0).map(\.id) == ids)
    s.update(ids.reversed().map { bus(path, 50, id: $0) }, path: path, now: 5)
    #expect(s.at(5).map(\.id) == ids.reversed(), "the latest answer's order")
}

/// The map plans its slides on every answer, the same or not: a bus that
/// stood still for a while still slides when it moves off.
@Test func aBusThatStoodStillStillSlides() {
    let path = RoutePath([[103.0, 1.0], [103.01, 1.0]])
    var s = Slides(duration: { _ in 1 })
    for t in stride(from: 0.0, through: 30, by: 5) { s.update([bus(path, 300)], path: path, now: t) }
    s.update([bus(path, 400)], path: path, now: 35)
    #expect(s.moving(35.5))
    #expect(near(s.at(35.5)[0].along, 350, 1e-6))
}

@Test func theSlidesClockCountsOn() {
    let a = Slides.clock
    #expect(a > 0)
    #expect(Slides.clock >= a)
}

@Test func aStopsBoardSaysTheServersTimes() throws {
    let b = try #require(StopBoard.parse(Data(#"{"available": true, "board": [{"svc": "D2", "etaS": 240, "quality": "live", "eta": "4 min"}, {"svc": "A1", "etaS": 300, "quality": "live"}]}"#.utf8)))
    #expect(b.rows[0].eta == "4 min")
    #expect(b.rows[1].eta == nil, "an older server's row is worded here")
}

@Test func onlyAPMTilesFileReplacesTheMap() {
    var head = Data("PMTiles".utf8) + Data([3])
    #expect(MapFiles.isPMTiles(head, size: 4_000_000))
    #expect(!MapFiles.isPMTiles(head, size: 2_000), "too small to be the campus")
    #expect(!MapFiles.isPMTiles(Data("<!DOCTYPE html>".utf8), size: 4_000_000), "a Wi-Fi sign-in page")
    head[7] = 2
    #expect(!MapFiles.isPMTiles(head, size: 4_000_000), "another version")
    #expect(!MapFiles.isPMTiles(Data("PMTiles".utf8), size: 4_000_000), "no version byte")
}
