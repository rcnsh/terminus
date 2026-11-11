import SwiftUI

/// The Nearby tab (ADR 0017): its title in a band of the hour's sky, as
/// Stops has, then the stops around you as their signs (NearbyList) and
/// when they came. Every chip on Now is somewhere to go; this is where you
/// are. A stop's name or a row opens the Stops tab on it, so at every width
/// this is one centred column with no second pane. As the web app's
/// NearbyArea.
struct NearbyView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    private let model = NearbyTabModel.shared
    private let locator = Locator.shared
    @State private var pull = SkyPull()

    /// The tab on screen with the app in front: the only time it asks.
    private var shown: Bool { app.tab == .nearby && scenePhase == .active }

    var body: some View {
        // In a stack of its own, as Stops' home is, so the two bands start at the same height.
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    SkyBand(moonLow: true) {
                        VStack(alignment: .leading, spacing: 0) {
                            PullRoom(above: 8, below: 8)
                            BandTitle(text: L("Nearby"))
                        }
                        .column()
                    }
                    .busBandEnd()
                    VStack(alignment: .leading, spacing: 0) {
                        notice
                        NearbyList()
                        footer
                    }
                    .column()
                    .padding(.top, 20)
                    .padding(.bottom, 24)
                }
            }
            .background(Color.page)
            .skyPull(pull, livery: livery, scene: { .hill($0) }) { await model.pull() }
            // Not shown: the title is in the sky.
            .navigationTitle(L("Nearby"))
            .toolbar(.hidden, for: .navigationBar)
            .busSkyChrome(strip: true)
        }
        // The stars: the pins full, or a pin that didn't save.
        .overlay(alignment: .top) { PinNote() }
        .onChange(of: shown, initial: true) { _, shown in model.onScreen = shown }
        .task(id: shown) {
            guard shown else { return }
            // Nearby is for nothing else, so opening it is the asking, as on the web.
            if locator.undecided { locator.ask() }
            // Fresh while it's on screen and the app's in front: every 30 s.
            await model.poll()
        }
        // Allowed or refused: the stops for where that puts you, now if the tab
        // is on screen, else when it next is (the system's question covers it meanwhile).
        .onChange(of: locator.status) { _, _ in
            model.locationChanged()
            if shown { Task { await model.load(restart: true) } }
        }
    }

    /// The pull's bus: in the colours of the first bus due at the nearest stop.
    private var livery: UInt32? {
        model.stops?.lazy.compactMap { $0.board.first(where: \.running)?.color }.first.flatMap(hexRGB)
    }

    /// Location refused: whose stops these are instead, and where to allow it.
    @ViewBuilder private var notice: some View {
        if locator.denied {
            SkyNotice(text: L("Without your location, these are the stops by your last class or your home.")) {
                Button(L("Open settings to allow location")) { openAppSettings() }
            }
            .padding(.bottom, 12)
        }
    }

    /// One quiet line under the signs, as under Now's card: "Updated 9:41",
    /// in campus time on the server's clock, or why the last refresh failed.
    @ViewBuilder private var footer: some View {
        let parts = [model.error, model.fetchedAt.map { L("Updated %@", campusTime($0.addingTimeInterval(ServerClock.skew))) }]
            .compactMap { $0 }
        if model.loading || !parts.isEmpty {
            HStack(spacing: 0) {
                if model.loading {
                    ProgressView()
                        .controlSize(.mini)
                        .padding(.trailing, 8)
                        .accessibilityLabel(L("Refreshing"))
                }
                Text(parts.joined(separator: " · "))
                    .foregroundStyle(model.error != nil ? Color.bad : Color.muted)
                    .announced(model.error)
            }
            .font(.footnote)
            .frame(minHeight: 28)
            .padding(.top, 10)
            .padding(.horizontal, 6)
        }
    }
}

/// The Stops tab's note, read here alone so a new one redraws only it.
private struct PinNote: View {
    var body: some View { NoteView(text: BusesModel.shared.note) }
}
