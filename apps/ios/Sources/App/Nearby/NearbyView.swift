import SwiftUI

struct NearbyView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    private let model = NearbyTabModel.shared
    private let locator = Locator.shared
    @State private var pull = SkyPull()

    private var shown: Bool { app.tab == .nearby && scenePhase == .active }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    TabBand(title: L("Nearby")).busBandEnd()
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
            .navigationTitle(L("Nearby"))
            .toolbar(.hidden, for: .navigationBar)
            .busSkyChrome(strip: true)
        }
        .overlay(alignment: .top) { PinNote() }
        .onChange(of: shown, initial: true) { _, shown in model.onScreen = shown }
        .task(id: shown) {
            guard shown else { return }
            if locator.undecided { locator.ask() }
            await model.poll()
        }
        .onChange(of: locator.status) { _, _ in
            model.locationChanged()
            if shown { Task { await model.load(restart: true) } }
        }
    }

    private var livery: UInt32? {
        model.stops?.lazy.compactMap { $0.board.first(where: \.running)?.color }.first.flatMap(hexRGB)
    }

    @ViewBuilder private var notice: some View {
        if locator.denied {
            SkyNotice(text: L("Without your location, these are the stops by your last class or your home.")) {
                Button(L("Open settings to allow location")) { openAppSettings() }
            }
            .padding(.bottom, 12)
        }
    }

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

private struct PinNote: View {
    var body: some View { NoteView(text: BusesModel.shared.note) }
}
