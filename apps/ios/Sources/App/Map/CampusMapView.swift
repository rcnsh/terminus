import CoreLocation
import MapLibre
import SwiftUI
import UIKit

private let nearCampusDeg = 0.027

private let followCoverS = 2.5

private func E(_ json: Any) -> NSExpression { NSExpression(mglJSONObject: json) }

private func zoomed(_ stops: Double...) -> NSExpression {
    var j: [Any] = ["interpolate", ["linear"], ["zoom"]]
    for s in stops { j.append(s) }
    return E(j)
}

private func shape(_ data: Data) -> MLNShape? { try? MLNShape(data: data, encoding: String.Encoding.utf8.rawValue) }

private let meBlue = UIColor(rgb: 0x2B7BF3)

struct CampusMapView: UIViewRepresentable {
    let map: MapModel
    let campus: CampusMap
    let style: URL
    let dark: Bool
    let still: Bool
    let cover: UIEdgeInsets
    let bars: UIEdgeInsets
    let floating: CGFloat
    let shown: Bool
    let drawn: Drawn

    struct Drawn: Equatable {
        let selected: String?
        let buses: [LiveBus]
        let answers: Int
        let stale: Bool
        let sheet: MapModel.Sheet?
        let me: MapModel.Spot?
        let recentre: Int
        let focusCount: Int
        let locateCount: Int
    }

    func makeCoordinator() -> Coordinator { Coordinator(map: map, campus: campus) }

    func makeUIView(context: Context) -> MLNMapView {
        let view = SizedMapView(frame: .zero, styleURL: style)
        view.sized = { [weak coordinator = context.coordinator] in coordinator?.resized() }
        view.delegate = context.coordinator
        view.compassView.isHidden = true
        view.logoView.isHidden = true
        view.attributionButtonPosition = .bottomLeft
        view.isRotateEnabled = false
        view.isPitchEnabled = false
        view.minimumZoomLevel = 13
        view.maximumZoomLevel = 19
        view.automaticallyAdjustsContentInset = false
        view.accessibilityIdentifier = "map"
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        for g in view.gestureRecognizers ?? [] {
            if let t = g as? UITapGestureRecognizer, t.numberOfTapsRequired == 2 { tap.require(toFail: t) }
        }
        view.addGestureRecognizer(tap)
        context.coordinator.view = view
        context.coordinator.styleURL = style
        return view
    }

    func updateUIView(_ view: MLNMapView, context: Context) {
        let c = context.coordinator
        c.campus = campus
        c.still = still
        c.shown = shown
        if c.cover != cover || c.bars != bars || c.floating != floating {
            let was = c.cover
            c.cover = cover
            c.bars = bars
            c.floating = floating
            c.coverChanged(from: was)
            view.attributionButtonMargins = CGPoint(x: 8 + cover.left, y: 8)
        }
        if c.dark != dark {
            c.dark = dark
            c.applied = nil
        }
        if c.styleURL != style {
            c.styleURL = style
            c.loaded = false
            view.styleURL = style
        }
        c.apply()
    }

    static func dismantleUIView(_ view: MLNMapView, coordinator: Coordinator) {
        coordinator.stopAnimating()
        view.delegate = nil
    }

    @MainActor final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate {
        let map: MapModel
        var campus: CampusMap
        weak var view: MLNMapView?
        var styleURL: URL?
        var dark = false
        var still = false
        var shown = true
        var loaded = false
        var cover = UIEdgeInsets.zero
        var bars = UIEdgeInsets.zero
        var floating: CGFloat = 0
        private var room: UIEdgeInsets {
            UIEdgeInsets(top: cover.top, left: cover.left + bars.left, bottom: cover.bottom + bars.bottom, right: cover.right + bars.right)
        }
        var applied: (selected: String?, stretch: Bool, bus: String?, stale: Bool)?

        private var slides = Slides()
        private var slidesFor: String?
        private var lastAnswer = 0
        private var link: CADisplayLink?
        private var drawnStretch: Data?
        private var drawnMe: Data?
        private var recentred = 0
        private var focused = 0
        private var located = 0
        private var framedLine: String?
        private var framed = false
        private var campusOnly = false
        private var lineOnly = false
        private var lineBesideSheet = false
        private var lineSheetSpot: MapModel.Spot?
        private var fittedSize = CGSize.zero
        private var keeping = false
        private var following: (spot: MapModel.Spot, until: Date)?

        init(map: MapModel, campus: CampusMap) {
            self.map = map
            self.campus = campus
        }

        private var paper: UIColor { dark ? UIColor(rgb: 0x1A1816) : .white }
        private var ink: UIColor { UIColor(rgb: dark ? 0xF2EFEB : 0x1C1917) }
        private var edge: UIColor { dark ? paper : ink }
        private var edgeAlpha: Double { dark ? 1 : 0.6 }
        private var color: String { campus.color(map.selected) }
        private var path: RoutePath? { map.selected.flatMap { campus.routes[$0]?.path } }

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            build(style)
            loaded = true
            applied = nil
            drawnStretch = nil
            drawnMe = nil
            apply()
            if let styleURL { MapFiles.styleLoaded(styleURL) }
        }

        func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: any Error) {
            guard let failed = mapView.styleURL, failed == styleURL else { return }
            Task { await map.tilesFailed(failed) }
        }

        func mapView(_ mapView: MLNMapView, shouldChangeFrom oldCamera: MLNMapCamera, to newCamera: MLNMapCamera) -> Bool {
            let zoom = mapView.zoomLevel + log2(oldCamera.altitude / newCamera.altitude)
            if abs(zoom - mapView.zoomLevel) > 0.001 { return true }
            let box = centreBox(mapView, zoom: zoom)
            let off = offBy(newCamera.centerCoordinate, box)
            return off == 0 || off < offBy(oldCamera.centerCoordinate, box)
        }

        func mapView(_ mapView: MLNMapView, regionWillChangeWith reason: MLNCameraChangeReason, animated: Bool) {
            if !reason.intersection([.gesturePan, .gesturePinch, .gestureZoomIn, .gestureZoomOut, .gestureOneFingerZoom]).isEmpty {
                following = nil
                campusOnly = false
                lineOnly = false
            }
        }

        func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) { keepOnMap() }

        func resized() {
            guard let view, view.bounds.width > 100, view.bounds.height > 100 else { return }
            let size = view.bounds.size
            defer { fittedSize = size }
            keepOnMap()
            if !framed {
                frameCampus()
            } else if size != fittedSize {
                if lineOnly, let r = map.selected.flatMap({ campus.routes[$0] }) {
                    let other = map.sheetSpot != nil && map.sheetSpot != lineSheetSpot
                    fitLine(r, animated: false)
                    if other { showSheetSpot() }
                } else if campusOnly, map.sheetSpot == nil {
                    fitCampus(animated: false)
                }
            }
            keepOnMap()
        }

        func keepOnMap() {
            guard !keeping, let view, view.bounds.width > 0, view.bounds.height > 0 else { return }
            keeping = true
            defer { keeping = false }
            let least = max(13, PanLimit.minZoom(width: view.bounds.width, height: view.bounds.height))
            if abs(view.minimumZoomLevel - least) > 1e-6 { view.minimumZoomLevel = least }
            let box = centreBox(view, zoom: view.zoomLevel)
            let c = view.centerCoordinate
            guard offBy(c, box) > 1e-9 else { return }
            view.setCenter(
                CLLocationCoordinate2D(latitude: min(max(c.latitude, box[1]), box[3]), longitude: min(max(c.longitude, box[0]), box[2])),
                animated: !still)
        }

        private func centreBox(_ view: MLNMapView, zoom: Double) -> [Double] {
            PanLimit.centre(
                width: view.bounds.width, height: view.bounds.height, zoom: zoom, left: Double(room.left),
                bottom: Double(room.bottom + floating))
        }

        private func offBy(_ c: CLLocationCoordinate2D, _ box: [Double]) -> Double {
            max(box[0] - c.longitude, c.longitude - box[2], box[1] - c.latitude, c.latitude - box[3], 0)
        }

        private func source(_ id: String, _ data: Data) -> MLNShapeSource {
            MLNShapeSource(identifier: id, shape: shape(data), options: nil)
        }

        private func line(_ id: String, _ src: MLNSource, color: NSExpression, width: NSExpression) -> MLNLineStyleLayer {
            let l = MLNLineStyleLayer(identifier: id, source: src)
            l.lineColor = color
            l.lineWidth = width
            l.lineCap = NSExpression(forConstantValue: "round")
            l.lineJoin = NSExpression(forConstantValue: "round")
            return l
        }

        private func busIcon(_ id: String, image: String, _ src: MLNSource) -> MLNSymbolStyleLayer {
            let l = MLNSymbolStyleLayer(identifier: id, source: src)
            l.iconImageName = NSExpression(forConstantValue: image)
            l.iconScale = zoomed(13, 0.64, 17, 1)
            l.iconRotation = E(["get", "heading"])
            l.iconRotationAlignment = NSExpression(forConstantValue: "map")
            l.iconOffset = E(["get", "offset"])
            l.iconAllowsOverlap = NSExpression(forConstantValue: true)
            return l
        }

        private func build(_ style: MLNStyle) {
            let routes = source("routes", MapGeoJson.routes(campus))
            let stops = source("stops", MapGeoJson.stops(campus))
            let labels = source("stop-labels", MapGeoJson.stops(campus))
            let stretch = source("stretch", MapGeoJson.empty)
            let me = source("me", MapGeoJson.empty)
            let buses = source("buses", MapGeoJson.empty)
            for s in [routes, stops, labels, stretch, me, buses] { style.addSource(s) }
            let byColor = E(["to-color", ["get", "color"]])

            style.addLayer(line("route-casing", routes, color: NSExpression(forConstantValue: edge), width: zoomed(13, 3, 16, 7, 18, 11)))
            style.addLayer(line("routes", routes, color: byColor, width: zoomed(13, 1.5, 16, 4, 18, 7)))
            let on = line("route-on", routes, color: byColor, width: zoomed(13, 3, 16, 6, 18, 9))
            on.predicate = NSPredicate(format: "svc == %@", "")
            style.addLayer(on)
            let stretchCasing = line(
                "stretch-casing", stretch, color: NSExpression(forConstantValue: edge), width: zoomed(13, 7, 16, 13, 18, 18))
            stretchCasing.lineOpacity = NSExpression(forConstantValue: edgeAlpha)
            style.addLayer(stretchCasing)
            style.addLayer(line("stretch", stretch, color: byColor, width: zoomed(13, 5, 16, 9, 18, 13)))

            let dots = MLNCircleStyleLayer(identifier: "stops", source: stops)
            dots.circleRadius = zoomed(13, 2.5, 16, 5.5, 18, 8)
            dots.circleColor = NSExpression(forConstantValue: paper)
            dots.circleStrokeColor = NSExpression(forConstantValue: ink)
            dots.circleStrokeWidth = zoomed(13, 1, 16, 2)
            style.addLayer(dots)

            let names = MLNSymbolStyleLayer(identifier: "stop-names", source: labels)
            names.minimumZoomLevel = 15
            names.text = E(["get", "name"])
            names.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            names.textFontSize = zoomed(15, 11, 18, 14)
            names.textColor = NSExpression(forConstantValue: ink)
            names.textHaloColor = NSExpression(forConstantValue: paper)
            names.textHaloWidth = NSExpression(forConstantValue: 2.5)
            names.textVariableAnchor = NSExpression(forConstantValue: ["top", "bottom", "right", "left"])
            names.textRadialOffset = NSExpression(forConstantValue: 0.9)
            names.textOptional = NSExpression(forConstantValue: true)
            names.maximumTextWidth = NSExpression(forConstantValue: 8)
            style.addLayer(names)
            style.setImage(UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { _ in }, forName: "stop-mark")
            let marks = MLNSymbolStyleLayer(identifier: "stop-marks", source: labels)
            marks.minimumZoomLevel = 15
            marks.iconImageName = NSExpression(forConstantValue: "stop-mark")
            marks.iconScale = zoomed(15, 0.6, 18, 1)
            marks.iconAllowsOverlap = NSExpression(forConstantValue: true)
            marks.iconOpacity = NSExpression(forConstantValue: 0)
            style.addLayer(marks)

            let halo = MLNCircleStyleLayer(identifier: "me-halo", source: me)
            halo.circleRadius = NSExpression(forConstantValue: 14)
            halo.circleColor = NSExpression(forConstantValue: meBlue)
            halo.circleOpacity = NSExpression(forConstantValue: 0.18)
            style.addLayer(halo)
            let dot = MLNCircleStyleLayer(identifier: "me", source: me)
            dot.circleRadius = NSExpression(forConstantValue: 6.5)
            dot.circleColor = NSExpression(forConstantValue: meBlue)
            dot.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
            style.addLayer(dot)

            let ring = busIcon("bus-on", image: "bus-on", buses)
            ring.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            ring.predicate = NSPredicate(format: "id == %@", "")
            style.addLayer(ring)
            for (id, image) in [("buses", "bus"), ("bus-heading", "heading")] {
                let l = busIcon(id, image: image, buses)
                l.iconIgnoresPlacement = NSExpression(forConstantValue: id == "bus-heading")
                style.addLayer(l)
            }
            style.setImage(Self.ringImage(ink), forName: "bus-on")
            style.setImage(Self.headingImage(), forName: "heading")
        }

        func apply() {
            guard loaded, let style = view?.style else { return }
            let selected = map.selected
            let open = map.openBus
            let stretchData = MapGeoJson.stretch(color: color, path: path, open?.stretch)
            let stretchOn = stretchData != MapGeoJson.empty
            let stale = map.busesStale
            let now = (selected, stretchOn, open?.id, stale)
            if applied == nil || applied! != now {
                applied = now
                (style.layer(withIdentifier: "route-casing") as? MLNLineStyleLayer)?.lineOpacity = NSExpression(
                    forConstantValue: (selected == nil ? 0.9 : 0.3) * edgeAlpha)
                (style.layer(withIdentifier: "routes") as? MLNLineStyleLayer)?.lineOpacity = NSExpression(
                    forConstantValue: selected == nil ? 0.9 : 0.18)
                if let on = style.layer(withIdentifier: "route-on") as? MLNLineStyleLayer {
                    on.predicate = NSPredicate(format: "svc == %@", selected ?? "")
                    on.lineOpacity = NSExpression(forConstantValue: stretchOn ? 0.2 : 1)
                }
                let onRoute: Any = selected.map { ["in", " \($0) ", ["get", "services"]] } ?? true
                let fade = E(["case", onRoute, 1, 0.35])
                if let dots = style.layer(withIdentifier: "stops") as? MLNCircleStyleLayer {
                    dots.circleOpacity = fade
                    dots.circleStrokeOpacity = fade
                }
                (style.layer(withIdentifier: "stop-names") as? MLNSymbolStyleLayer)?.textOpacity = E(["case", onRoute, 1, 0.4])
                (style.layer(withIdentifier: "bus-on") as? MLNSymbolStyleLayer)?.predicate = NSPredicate(format: "id == %@", open?.id ?? "")
                style.setImage(Self.busImage(fill: UIColor(rgb: hexRGB(color) ?? 0x8A939C), ring: edge), forName: "bus")
                for id in ["buses", "bus-heading", "bus-on"] {
                    (style.layer(withIdentifier: id) as? MLNSymbolStyleLayer)?.iconOpacity = NSExpression(forConstantValue: stale ? 0.4 : 1)
                }
            }
            if stretchData != drawnStretch {
                drawnStretch = stretchData
                (style.source(withIdentifier: "stretch") as? MLNShapeSource)?.shape = shape(stretchData)
            }
            let meData = map.me.map { MapGeoJson.me(lat: $0.lat, lon: $0.lon) } ?? MapGeoJson.empty
            if meData != drawnMe {
                drawnMe = meData
                (style.source(withIdentifier: "me") as? MLNShapeSource)?.shape = shape(meData)
            }

            if slidesFor != selected {
                slides = Slides()
                slidesFor = selected
                lastAnswer = map.busAnswers - 1
            }
            if map.busAnswers != lastAnswer {
                lastAnswer = map.busAnswers
                slides.update(map.buses, path: path, now: Slides.clock, still: still || !shown)
                animate()
            }
            drawBuses()
            camera()
        }

        private func drawBuses() {
            guard let src = view?.style?.source(withIdentifier: "buses") as? MLNShapeSource else { return }
            let svc = map.selected ?? ""
            let color = color
            let features = slides.at(Slides.clock).map { b in
                let f = MLNPointFeature()
                f.coordinate = CLLocationCoordinate2D(latitude: b.lat, longitude: b.lon)
                f.attributes = MapGeoJson.busProperties(svc: svc, color: color, b)
                return f
            }
            src.shape = MLNShapeCollectionFeature(shapes: features)
        }

        private func animate() {
            guard link == nil, shown, view?.window != nil else { return }
            let l = CADisplayLink(target: LinkTarget(self), selector: #selector(LinkTarget.tick))
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
            l.add(to: .main, forMode: .common)
            link = l
        }

        func stopAnimating() {
            link?.invalidate()
            link = nil
        }

        fileprivate func frame() {
            guard shown, view?.window != nil else { return stopAnimating() }
            drawBuses()
            if !slides.moving(Slides.clock) { stopAnimating() }
        }

        private func bounds(_ b: [Double]) -> MLNCoordinateBounds {
            MLNCoordinateBounds(
                sw: CLLocationCoordinate2D(latitude: b[1], longitude: b[0]), ne: CLLocationCoordinate2D(latitude: b[3], longitude: b[2]))
        }

        private func padding(_ side: CGFloat, _ more: CGFloat = 16) -> UIEdgeInsets {
            UIEdgeInsets(top: room.top + more, left: room.left + side, bottom: room.bottom + more, right: room.right + side)
        }

        func frameCampus() {
            guard !framed, let view, view.bounds.width > 100, view.bounds.height > 100 else { return }
            framed = true
            if map.focusCount != focused, let f = map.focus {
                focused = map.focusCount
                following = (f, Date().addingTimeInterval(followCoverS))
                return centre(on: f, animated: false)
            }
            fitCampus(animated: false)
            if let at = Locator.shared.last?.coordinate,
                let near = campus.stops.min(by: {
                    pow($0.lat - at.latitude, 2) + pow($0.lon - at.longitude, 2) < pow($1.lat - at.latitude, 2)
                        + pow($1.lon - at.longitude, 2)
                }),
                abs(near.lat - at.latitude) < nearCampusDeg, abs(near.lon - at.longitude) < nearCampusDeg
            {
                view.setCenter(CLLocationCoordinate2D(latitude: near.lat, longitude: near.lon), zoomLevel: 17, animated: false)
                campusOnly = false
            }
        }

        private func fitCampus(animated: Bool) {
            view?.setVisibleCoordinateBounds(
                bounds(campus.coreBounds), edgePadding: padding(24), animated: animated, completionHandler: nil)
            campusOnly = true
        }

        private func fitLine(_ r: MapRoute, animated: Bool, then done: (() -> Void)? = nil) {
            guard let view else { return }
            let box = bounds(r.bounds)
            let size = view.bounds.size
            let shown = cover.bottom == 0
            var covers = [room]
            if floating > 0 {
                covers.append(UIEdgeInsets(top: cover.top, left: bars.left, bottom: bars.bottom + floating, right: bars.right))
            }
            let buttons = shown ? [CGSize(width: Self.buttonsWidth, height: 0), CGSize(width: 0, height: Self.buttonsHeight)] : [.zero]
            let pads = covers.flatMap { c in buttons.map { LineRoom.padding(cover: c, buttons: $0, bars: bars, in: size) } }
            let pad = pads.min {
                view.cameraThatFitsCoordinateBounds(box, edgePadding: $0).altitude
                    < view.cameraThatFitsCoordinateBounds(box, edgePadding: $1).altitude
            }!
            view.setVisibleCoordinateBounds(box, edgePadding: pad, animated: animated, completionHandler: done)
            campusOnly = false
            lineOnly = true
            lineBesideSheet = map.sheetSpot != nil
            lineSheetSpot = map.sheetSpot
        }

        static let buttonsWidth: CGFloat = 44 + 12
        static let buttonsHeight: CGFloat = 44 * 2 + 10 + 16

        private func camera() {
            guard view != nil, framed else { return }
            if map.recentre != recentred {
                recentred = map.recentre
                following = nil
                lineOnly = false
                fitCampus(animated: !still)
            }
            if map.selected != framedLine {
                framedLine = map.selected
                lineOnly = false
                if let r = map.selected.flatMap({ campus.routes[$0] }) {
                    following = nil
                    fitLine(r, animated: !still)
                }
            }
            if map.focusCount != focused, let f = map.focus {
                focused = map.focusCount
                following = (f, Date().addingTimeInterval(followCoverS))
                centre(on: f)
            }
            if map.locateCount != located, let me = map.me {
                located = map.locateCount
                following = nil
                centre(on: me)
            }
        }

        func coverChanged(from was: UIEdgeInsets) {
            let sheet = map.sheetSpot != nil
            if framed, lineOnly, sheet ? lineBesideSheet : was.top != cover.top || lineBesideSheet,
                let r = map.selected.flatMap({ campus.routes[$0] })
            {
                let other = sheet && map.sheetSpot != lineSheetSpot
                return fitLine(r, animated: !still) { [weak self] in if other { self?.showSheetSpot() } }
            }
            if framed, campusOnly, was.top != cover.top, !sheet { return fitCampus(animated: !still) }
            if let f = following, Date() < f.until { return centre(on: f.spot) }
            following = nil
            showSheetSpot()
        }

        private func showSheetSpot() {
            guard let view, let spot = map.sheetSpot else { return keepOnMap() }
            let p = view.convert(CLLocationCoordinate2D(latitude: spot.lat, longitude: spot.lon), toPointTo: view)
            let top = room.top + 24
            let bottom = view.bounds.height - room.bottom - 24
            let cornered = p.x < room.left && p.y > view.bounds.height - bars.bottom - floating - 24
            guard bottom > top, p.y < top || p.y > bottom || cornered || p.x > view.bounds.width - room.right else { return keepOnMap() }
            centre(on: spot)
        }

        private func centre(on spot: MapModel.Spot, animated: Bool = true) {
            guard let view else { return }
            campusOnly = false
            lineOnly = false
            let zoom = max(view.zoomLevel, 17)
            let up = Double(room.bottom - room.top) / 2
            let right = Double(room.left - room.right) / 2
            let degrees = 360 / (512 * pow(2, zoom))
            let lat = spot.lat - up * degrees * cos(spot.lat * .pi / 180)
            let lon = spot.lon - right * degrees
            view.setCenter(CLLocationCoordinate2D(latitude: lat, longitude: lon), zoomLevel: zoom, animated: animated && !still)
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view, g.state == .ended else { return }
            let p = g.location(in: view)
            let busRect = CGRect(x: p.x - 18, y: p.y - 18, width: 36, height: 36)
            if let id = view.visibleFeatures(in: busRect, styleLayerIdentifiers: ["buses"]).first?.attribute(forKey: "id") as? String {
                map.open(bus: id)
                return
            }
            let stopRect = CGRect(x: p.x - 22, y: p.y - 22, width: 44, height: 44)
            let codes = view.visibleFeatures(in: stopRect, styleLayerIdentifiers: ["stops", "stop-names"]).compactMap {
                $0.attribute(forKey: "code") as? String
            }
            let at = view.convert(p, toCoordinateFrom: view)
            if let code = campus.nearest(codes, lat: at.latitude, lon: at.longitude) {
                map.open(stop: code)
            } else if map.sheet != nil {
                map.closeSheet()
            }
        }

        static func busImage(fill: UIColor, ring: UIColor) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 27, height: 27)).image { ctx in
                let r = CGRect(x: 0, y: 0, width: 27, height: 27)
                ring.setFill()
                ctx.cgContext.fillEllipse(in: r)
                fill.setFill()
                ctx.cgContext.fillEllipse(in: r.insetBy(dx: 2.5, dy: 2.5))
            }
        }

        static func ringImage(_ ink: UIColor) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { ctx in
                ink.setStroke()
                ctx.cgContext.setLineWidth(2.5)
                ctx.cgContext.strokeEllipse(in: CGRect(x: 3.5, y: 3.5, width: 33, height: 33))
            }
        }

        static func headingImage() -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { ctx in
                let p = UIBezierPath()
                p.move(to: CGPoint(x: 6, y: 1.5))
                p.addLine(to: CGPoint(x: 9.5, y: 8.5))
                p.addLine(to: CGPoint(x: 6, y: 6.8))
                p.addLine(to: CGPoint(x: 2.5, y: 8.5))
                p.close()
                UIColor.white.setFill()
                p.fill()
            }
        }
    }
}

@MainActor private final class LinkTarget: NSObject {
    weak var coordinator: CampusMapView.Coordinator?

    init(_ coordinator: CampusMapView.Coordinator) { self.coordinator = coordinator }

    @objc func tick(_ link: CADisplayLink) {
        guard let coordinator else { return link.invalidate() }
        coordinator.frame()
    }
}

enum LineRoom {
    static func padding(cover: UIEdgeInsets, buttons: CGSize, bars: UIEdgeInsets = .zero, in size: CGSize) -> UIEdgeInsets {
        var p = UIEdgeInsets(
            top: cover.top + 24,
            left: cover.left > 0 ? cover.left + 24 : 40,
            bottom: cover.bottom > 0 ? cover.bottom + 24 : 40,
            right: cover.right > 0 ? cover.right + 24 : 40)
        if buttons.width > 0 { p.right = bars.right + buttons.width + 24 }
        if buttons.height > 0 { p.bottom = max(p.bottom, bars.bottom + buttons.height + 24) }
        let across = size.width * 0.75
        if p.left + p.right > across {
            let k = across / (p.left + p.right)
            p.left *= k
            p.right *= k
        }
        let down = size.height * 0.75
        if p.top + p.bottom > down {
            let k = down / (p.top + p.bottom)
            p.top *= k
            p.bottom *= k
        }
        return p
    }
}

private final class SizedMapView: MLNMapView {
    var sized: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        DispatchQueue.main.async { [weak self] in self?.sized?() }
    }
}
