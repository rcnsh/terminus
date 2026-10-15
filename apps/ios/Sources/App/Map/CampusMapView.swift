import CoreLocation
import MapLibre
import SwiftUI
import UIKit

/// Further than this from campus (in degrees, about 3 km), the map opens on campus, not on you.
private let nearCampusDeg = 0.027

/// How long after moving onto a stop the map keeps it clear of its sheet as that grows.
private let followCoverS = 2.5

/// A style-spec expression, as the other apps' maps write them.
private func E(_ json: Any) -> NSExpression { NSExpression(mglJSONObject: json) }

private func zoomed(_ stops: Double...) -> NSExpression {
    var j: [Any] = ["interpolate", ["linear"], ["zoom"]]
    for s in stops { j.append(s) }
    return E(j)
}

/// GeoJSON as a shape for a source.
private func shape(_ data: Data) -> MLNShape? { try? MLNShape(data: data, encoding: String.Encoding.utf8.rawValue) }

/// Your dot, and the halo round it.
private let meBlue = UIColor(rgb: 0x2B7BF3)

/// MapLibre's own view, drawn from the model: sources and layers are added
/// once each time a style loads, then only their data and filters change.
/// As the Mac's CampusMapView, with a finger for a mouse.
struct CampusMapView: UIViewRepresentable {
    let map: MapModel
    let campus: CampusMap
    let style: URL
    let dark: Bool
    /// Reduce Motion: buses and the camera jump rather than glide.
    let still: Bool
    /// How much of the map the pills (top) and the sheet (bottom) cover, in points.
    let cover: UIEdgeInsets
    /// The tab is on screen and the app active: the buses' slides are drawn only then.
    let shown: Bool
    /// What it draws from the model, so SwiftUI updates it when any of it changes.
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
        view.sized = { [weak coordinator = context.coordinator] in
            coordinator?.frameCampus()
            coordinator?.keepOnMap()
        }
        view.delegate = context.coordinator
        view.compassView.isHidden = true
        // The map isn't MapLibre's: only the data's own credit (the ⓘ button) stays.
        view.logoView.isHidden = true
        view.attributionButtonPosition = .bottomLeft
        view.isRotateEnabled = false
        view.isPitchEnabled = false
        view.minimumZoomLevel = 13
        view.maximumZoomLevel = 19
        view.automaticallyAdjustsContentInset = false
        view.accessibilityIdentifier = "map"
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        // A double tap zooms; a single one waits to be sure it isn't one.
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
        if c.cover != cover {
            c.cover = cover
            c.coverChanged()
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

    /// The map's gone: the slide's display link stops with it, and the view
    /// no longer calls back into a coordinator that's going.
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
        var applied: (selected: String?, stretch: Bool, bus: String?, stale: Bool)?

        private var slides = Slides()
        private var slidesFor: String?
        private var lastAnswer = 0
        private var link: CADisplayLink?
        /// What the stretch and your dot were last set to: set again only when they change.
        private var drawnStretch: Data?
        private var drawnMe: Data?
        private var recentred = 0
        private var focused = 0
        private var located = 0
        private var framedLine: String?
        private var framed = false
        private var keeping = false
        /// The place last moved onto, and when: kept clear of the sheet as it
        /// grows for a moment after, unless a finger has moved the map since.
        private var following: (spot: MapModel.Spot, until: Date)?

        init(map: MapModel, campus: CampusMap) {
            self.map = map
            self.campus = campus
        }

        private var paper: UIColor { dark ? UIColor(rgb: 0x1A1816) : .white }
        private var ink: UIColor { UIColor(rgb: dark ? 0xF2EFEB : 0x1C1917) }
        /// What edges the lines and buses. On the light street map a service's
        /// own colour (A2's yellow, K's blue) is faint against the white roads:
        /// edged in the ink there, so it stands out. In the dark, the paper does that.
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

        /// A map file MapLibre can't read: dropped, and the plain map instead.
        func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: any Error) {
            // A style already replaced (the look changed) failing is no news.
            guard let failed = mapView.styleURL, failed == styleURL else { return }
            Task { await map.tilesFailed(failed) }
        }

        // MARK: staying on the map

        /// The screen stays on the street map (PanLimit): a drag off it is
        /// refused. A zoom goes ahead, and one out by an edge is brought back
        /// once it ends (keepOnMap), as is a drag that heads back on.
        func mapView(_ mapView: MLNMapView, shouldChangeFrom oldCamera: MLNMapCamera, to newCamera: MLNMapCamera) -> Bool {
            let zoom = mapView.zoomLevel + log2(oldCamera.altitude / newCamera.altitude)
            if abs(zoom - mapView.zoomLevel) > 0.001 { return true }
            let box = centreBox(mapView, zoom: zoom)
            let off = offBy(newCamera.centerCoordinate, box)
            return off == 0 || off < offBy(oldCamera.centerCoordinate, box)
        }

        func mapView(_ mapView: MLNMapView, regionWillChangeWith reason: MLNCameraChangeReason, animated: Bool) {
            // A finger on the map: it no longer follows the sheet.
            if !reason.intersection([.gesturePan, .gesturePinch, .gestureZoomIn, .gestureZoomOut, .gestureOneFingerZoom]).isEmpty {
                following = nil
            }
        }

        func mapView(_ mapView: MLNMapView, regionDidChangeAnimated animated: Bool) { keepOnMap() }

        /// Back onto the street map after a zoom out by its edge, and no
        /// further out than the screen full of map.
        func keepOnMap() {
            // Setting a limit moves the camera, which calls back here at once.
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
            PanLimit.centre(width: view.bounds.width, height: view.bounds.height, zoom: zoom)
        }

        /// How far (in degrees, the larger way) `c` is outside `box`; 0 inside it.
        private func offBy(_ c: CLLocationCoordinate2D, _ box: [Double]) -> Double {
            max(box[0] - c.longitude, c.longitude - box[2], box[1] - c.latitude, c.latitude - box[3], 0)
        }

        // MARK: layers

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

        /// A bus's icon, turned with the road and drawn at its offset from where it is.
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
            let stretch = source("stretch", MapGeoJson.empty)
            let me = source("me", MapGeoJson.empty)
            let buses = source("buses", MapGeoJson.empty)
            for s in [routes, stops, stretch, me, buses] { style.addSource(s) }
            let byColor = E(["to-color", ["get", "color"]])

            style.addLayer(line("route-casing", routes, color: NSExpression(forConstantValue: edge), width: zoomed(13, 3, 16, 7, 18, 11)))
            style.addLayer(line("routes", routes, color: byColor, width: zoomed(13, 1.5, 16, 4, 18, 7)))
            // The chosen service, drawn again on top.
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

            let names = MLNSymbolStyleLayer(identifier: "stop-names", source: stops)
            names.minimumZoomLevel = 15
            names.text = E(["get", "name"])
            names.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            names.textFontSize = zoomed(15, 11, 18, 14)
            names.textColor = NSExpression(forConstantValue: ink)
            names.textHaloColor = NSExpression(forConstantValue: paper)
            names.textHaloWidth = NSExpression(forConstantValue: 1.5)
            // Below the dot, or another side of it when a bus is there.
            names.textVariableAnchor = NSExpression(forConstantValue: ["top", "bottom", "right", "left"])
            names.textRadialOffset = NSExpression(forConstantValue: 0.9)
            names.textOptional = NSExpression(forConstantValue: true)
            names.maximumTextWidth = NSExpression(forConstantValue: 8)
            style.addLayer(names)

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

            // An icon, not a circle, so a bus at a stop can sit beside the dot
            // (its offset is per bus, and turns with the road). The offset is
            // in the bus's own frame, so the ring turns with the bus too, or
            // it lands beside it.
            let ring = busIcon("bus-on", image: "bus-on", buses)
            ring.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            ring.predicate = NSPredicate(format: "id == %@", "")
            style.addLayer(ring)
            for (id, image) in [("buses", "bus"), ("bus-heading", "heading")] {
                let l = busIcon(id, image: image, buses)
                // Stop names keep clear of buses (they move to another side of their dot).
                l.iconIgnoresPlacement = NSExpression(forConstantValue: id == "bus-heading")
                style.addLayer(l)
            }
            style.setImage(Self.ringImage(ink), forName: "bus-on")
            style.setImage(Self.headingImage(), forName: "heading")
        }

        // MARK: drawing the model

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
                // Where the buses were last seen, not where they are: faded.
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

            // Buses slide to each new place along their line (see Slides).
            // Every answer, even one the same as the last: a bus only jumps
            // after a while without one (Slides.staleS).
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

        /// Features made here, not GeoJSON written and read again: a slide
        /// sets them every frame.
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

        /// Redraws the buses with the screen while one is on its way, at up
        /// to 30 frames a second: enough for a bus crossing a few pixels.
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

        // MARK: the camera

        /// [west, south, east, north] as MapLibre's bounds.
        private func bounds(_ b: [Double]) -> MLNCoordinateBounds {
            MLNCoordinateBounds(
                sw: CLLocationCoordinate2D(latitude: b[1], longitude: b[0]), ne: CLLocationCoordinate2D(latitude: b[3], longitude: b[2]))
        }

        /// Room round what's framed: the pills along the top, the sheet at the bottom.
        private func padding(_ side: CGFloat, _ more: CGFloat = 16) -> UIEdgeInsets {
            UIEdgeInsets(top: cover.top + more, left: side, bottom: cover.bottom + more, right: side)
        }

        /// First view: your nearest stop when you're on campus, otherwise the
        /// whole campus; once the view has a size to fit it in. A stop opened
        /// from another tab is the first view instead (camera()).
        func frameCampus() {
            guard !framed, let view, view.bounds.width > 100, view.bounds.height > 100 else { return }
            framed = true
            if map.focusCount != focused { return camera() }
            view.setVisibleCoordinateBounds(bounds(campus.coreBounds), edgePadding: padding(24), animated: false, completionHandler: nil)
            if let at = Locator.shared.last?.coordinate,
                let near = campus.stops.min(by: {
                    pow($0.lat - at.latitude, 2) + pow($0.lon - at.longitude, 2) < pow($1.lat - at.latitude, 2)
                        + pow($1.lon - at.longitude, 2)
                }),
                abs(near.lat - at.latitude) < nearCampusDeg, abs(near.lon - at.longitude) < nearCampusDeg
            {
                view.setCenter(CLLocationCoordinate2D(latitude: near.lat, longitude: near.lon), zoomLevel: 17, animated: false)
            }
        }

        private func camera() {
            guard let view, framed else { return }
            // Back to campus, from the button or the tab tapped again.
            if map.recentre != recentred {
                recentred = map.recentre
                following = nil
                view.setVisibleCoordinateBounds(
                    bounds(campus.coreBounds), edgePadding: padding(24), animated: !still, completionHandler: nil)
            }
            // A pill: its whole line in view, when it's chosen.
            if map.selected != framedLine {
                framedLine = map.selected
                if let r = map.selected.flatMap({ campus.routes[$0] }) {
                    following = nil
                    // The whole line, under the pills: a sheet open over it closes or is dragged away.
                    let pad = UIEdgeInsets(top: cover.top + 24, left: 40, bottom: 40, right: 40)
                    view.setVisibleCoordinateBounds(bounds(r.bounds), edgePadding: pad, animated: !still, completionHandler: nil)
                }
            }
            // A stop opened from another tab or a bus's sheet, or the bus back
            // went to: the map glides onto it, clear of the sheet.
            if map.focusCount != focused, let f = map.focus {
                focused = map.focusCount
                following = (f, Date().addingTimeInterval(followCoverS))
                centre(on: f)
            }
            // "Show where you are".
            if map.locateCount != located, let me = map.me {
                located = map.locateCount
                following = nil
                centre(on: me)
            }
        }

        /// The sheet grew (its rows came) or the pills moved: a place just
        /// moved onto stays in the middle of what they leave uncovered.
        /// Otherwise a sheet that opened or grew over its own stop or bus
        /// moves the map just enough to show it again.
        func coverChanged() {
            if let f = following, Date() < f.until { return centre(on: f.spot) }
            following = nil
            guard let view, let spot = map.sheetSpot else { return }
            let p = view.convert(CLLocationCoordinate2D(latitude: spot.lat, longitude: spot.lon), toPointTo: view)
            let top = cover.top + 24
            let bottom = view.bounds.height - cover.bottom - 24
            guard bottom > top, p.y < top || p.y > bottom || p.x < 0 || p.x > view.bounds.width else { return }
            centre(on: spot)
        }

        /// Close in on `spot` (zoom 17, or nearer if already), in the middle
        /// of what the pills and the sheet leave uncovered.
        private func centre(on spot: MapModel.Spot) {
            guard let view else { return }
            let zoom = max(view.zoomLevel, 17)
            // How far above the map's middle the uncovered part's middle is, in
            // points, then in degrees of latitude at that zoom (the world is 512
            // points round at zoom 0, its north-south scale cos(lat) of that).
            let up = Double(cover.bottom - cover.top) / 2
            let lat = spot.lat - up * 360 / (512 * pow(2, zoom)) * cos(spot.lat * .pi / 180)
            view.setCenter(CLLocationCoordinate2D(latitude: lat, longitude: spot.lon), zoomLevel: zoom, animated: !still)
        }

        // MARK: taps

        /// A bus first (it's on top), then the stop nearest the finger; else the sheet closes.
        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view, g.state == .ended else { return }
            let p = g.location(in: view)
            let busRect = CGRect(x: p.x - 18, y: p.y - 18, width: 36, height: 36)
            if let id = view.visibleFeatures(in: busRect, styleLayerIdentifiers: ["buses"]).first?.attribute(forKey: "id") as? String {
                map.open(bus: id)
                return
            }
            // About a fingertip: the dots are small.
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

        // MARK: icons

        /// A bus: a disc of `fill`, 27 points across, ringed 2.5 points in `ring`.
        static func busImage(fill: UIColor, ring: UIColor) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 27, height: 27)).image { ctx in
                let r = CGRect(x: 0, y: 0, width: 27, height: 27)
                ring.setFill()
                ctx.cgContext.fillEllipse(in: r)
                fill.setFill()
                ctx.cgContext.fillEllipse(in: r.insetBy(dx: 2.5, dy: 2.5))
            }
        }

        /// The tapped bus's ring, in the map's ink, a little way out from the bus.
        static func ringImage(_ ink: UIColor) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { ctx in
                ink.setStroke()
                ctx.cgContext.setLineWidth(2.5)
                ctx.cgContext.strokeEllipse(in: CGRect(x: 3.5, y: 3.5, width: 33, height: 33))
            }
        }

        /// Which way a bus is going: points north before it's turned.
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

/// The display link's target. The link holds its target strongly, so this
/// holds the coordinator weakly: once that's gone, the link stops itself
/// rather than firing for ever.
@MainActor private final class LinkTarget: NSObject {
    weak var coordinator: CampusMapView.Coordinator?

    init(_ coordinator: CampusMapView.Coordinator) { self.coordinator = coordinator }

    @objc func tick(_ link: CADisplayLink) {
        guard let coordinator else { return link.invalidate() }
        coordinator.frame()
    }
}

/// MapLibre's view, saying when it's laid out: a camera fitted before then has nothing to fit in.
private final class SizedMapView: MLNMapView {
    var sized: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        // MapLibre takes in its new size during layout; a turn later it can fit a camera.
        DispatchQueue.main.async { [weak self] in self?.sized?() }
    }
}
