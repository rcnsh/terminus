import AppKit
import CoreLocation
import MapLibre
import Testing

@testable import Terminus

/// The map window's camera on a real MLNMapView (the vendored MapLibre):
/// it stays on the street map (`keepOnMap`) however the moves overlap.
@MainActor @Suite(.serialized) struct KeepOnMapTests {
    private func spin(_ s: TimeInterval) async throws { try await Task.sleep(for: .seconds(s)) }

    /// MapLibre names its cache after the app's bundle id, which the test runner hasn't got.
    private static let named: Void = {
        let m = class_getInstanceMethod(Bundle.self, #selector(getter: Bundle.bundleIdentifier))!
        let original = unsafeBitCast(method_getImplementation(m), to: (@convention(c) (Bundle, Selector) -> String?).self)
        let sel = #selector(getter: Bundle.bundleIdentifier)
        let block: @convention(block) (Bundle) -> String? = { b in original(b, sel) ?? (b == Bundle.main ? "run.terminus.tests" : nil) }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }()

    init() { _ = Self.named }

    /// A 600 by 400 window on a plain style at `zoom` over (`lat`, `lon`), kept on the map by the window's coordinator.
    private func window(zoom: Double, lat: Double, lon: Double) async throws -> (NSWindow, MLNMapView, CampusMapView.Coordinator) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("terminus-map-tests")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let style = dir.appendingPathComponent("style.json")
        try? Data(#"{"version":8,"sources":{},"layers":[{"id":"bg","type":"background","paint":{"background-color":"white"}}]}"#.utf8)
            .write(to: style)
        let w = NSWindow(
            contentRect: NSRect(x: 100, y: 100, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        let view = MLNMapView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), styleURL: style)
        w.contentView = view
        w.orderFront(nil)
        view.zoomLevel = zoom
        view.setCenter(CLLocationCoordinate2D(latitude: lat, longitude: lon), animated: false)
        try await spin(1)
        let c = CampusMapView.Coordinator(map: MapModel(), campus: CampusMap(stops: [], routes: [:], core: []))
        c.view = view
        view.delegate = c
        return (w, view, c)
    }

    /// Closed but kept: MapLibre's renderer can abort when a view is freed
    /// in the test runner (in ThreadLocalBase::set, from ~Renderer).
    private static var closed: [(NSWindow, MLNMapView, CampusMapView.Coordinator)] = []

    private func close(_ w: NSWindow, _ view: MLNMapView, _ c: CampusMapView.Coordinator) {
        view.delegate = nil
        w.orderOut(nil)
        Self.closed.append((w, view, c))
    }

    /// How far the centre is off where it may be at this zoom, in degrees.
    private func off(_ view: MLNMapView) -> Double {
        let box = PanLimit.centre(width: view.bounds.width, height: view.bounds.height, zoom: view.zoomLevel)
        let c = view.centerCoordinate
        return max(box[0] - c.longitude, c.longitude - box[2], box[1] - c.latitude, c.latitude - box[3], 0)
    }

    @Test func aMoveOffTheMapIsBroughtBack() async throws {
        let (w, view, c) = try await window(zoom: 16, lat: 1.30, lon: 103.78)
        defer { close(w, view, c) }
        view.setCenter(CLLocationCoordinate2D(latitude: 1.30, longitude: 103.70), animated: false)
        try await spin(1)
        #expect(off(view) < 1e-6)
    }

    @Test func aSecondZoomOutByTheEdgeStillEndsOnTheMap() async throws {
        let (w, view, c) = try await window(zoom: 16, lat: 1.30, lon: 103.759)
        defer { close(w, view, c) }
        view.setZoomLevel(14.5, animated: true)
        try await spin(0.15)
        // The second press ends the first move where it is, off the map's edge, inside this call.
        view.setZoomLevel(14, animated: true)
        try await spin(1.5)
        #expect(off(view) < 1e-6)
        // And the window still keeps to the map after that.
        view.setCenter(CLLocationCoordinate2D(latitude: 1.30, longitude: 103.70), animated: false)
        try await spin(1)
        #expect(off(view) < 1e-6)
    }

    @Test func aZoomOutDuringTheMoveBackStillEndsOnTheMap() async throws {
        let (w, view, c) = try await window(zoom: 16, lat: 1.30, lon: 103.78)
        defer { close(w, view, c) }
        view.setCenter(CLLocationCoordinate2D(latitude: 1.30, longitude: 103.70), animated: false)
        try await spin(0.1)
        // A zoom out cuts the move back short, further off the edge at the new zoom.
        view.setZoomLevel(14, animated: true)
        try await spin(1.5)
        #expect(off(view) < 1e-6)
    }
}
