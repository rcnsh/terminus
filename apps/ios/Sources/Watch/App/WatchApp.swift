import SwiftUI

/// terminus on the wrist: Now, Nearby and the headline in the phone's words
/// (ADR 0016), set up from the iPhone, fetching on its own.
@main
struct TerminusWatchApp: App {
    @Environment(\.scenePhase) private var phase

    init() {
        #if DEBUG
            WatchDevLaunch.apply()
        #endif
        PhoneLink.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            WatchRoot()
                .environment(WatchModel.shared)
        }
        // A code from the phone, delivered while the app is in the background.
        .backgroundTask(.watchConnectivity) {
            try? await Task.sleep(for: .seconds(5))
        }
    }
}

struct WatchRoot: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @State private var choosing = false
    @State private var started = false

    var body: some View {
        NavigationStack {
            Group {
                if model.paired {
                    NowScreen()
                        .navigationTitle(model.view.label)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    choosing = true
                                } label: {
                                    Image(systemName: "list.bullet")
                                }
                                .accessibilityLabel(L("Choose what to show"))
                                .accessibilityIdentifier("targets")
                            }
                        }
                        .sheet(isPresented: $choosing) { NavigationStack { TargetsList() } }
                        // Fetched on appearing and at each next moment, while it's on screen and the app is in front.
                        .task(id: Run(view: model.view, active: phase == .active)) {
                            guard phase == .active else { return }
                            await model.follow()
                        }
                } else {
                    SetupView()
                }
            }
        }
        // Every word drawn again in the account's language once it's known.
        .id(model.lang)
        .onChange(of: phase) { _, p in if p == .active { model.reopened() } }
        #if DEBUG
            .onAppear {
                guard !started else { return }
                started = true
                if let v = WatchDevLaunch.view() { model.choose(v) }
                if WatchDevLaunch.show == "targets" { choosing = true }
            }
            .sheet(isPresented: .constant(WatchDevLaunch.show == "complications")) { ComplicationGallery() }
        #endif
        .onOpenURL { _ in model.choose(.plan) }
    }

    private struct Run: Hashable {
        let view: WatchModel.View
        let active: Bool
    }
}

#if DEBUG
    /// For screenshots and the UI test, in debug builds only, as the phone's
    /// DevLaunch: TERMINUS_RESET=1 starts signed out with nothing kept,
    /// TERMINUS_TOKEN signs in with that token, TERMINUS_LANG=en|zh sets
    /// the language and TERMINUS_API_BASE the server. TERMINUS_VIEW=nearby
    /// or place:<key>:<label> opens on that view, and TERMINUS_SHOW=targets
    /// on the list, or complications on each complication drawn in the app.
    enum WatchDevLaunch {
        static var show: String? { ProcessInfo.processInfo.environment["TERMINUS_SHOW"] }

        @MainActor static func view() -> WatchModel.View? {
            guard let v = ProcessInfo.processInfo.environment["TERMINUS_VIEW"] else { return nil }
            if v == "nearby" { return .nearby }
            let parts = v.split(separator: ":", maxSplits: 2).map(String.init)
            if parts.count == 3, parts[0] == "place" { return .place(key: parts[1], label: parts[2]) }
            return nil
        }

        static func apply() {
            let env = ProcessInfo.processInfo.environment
            if env["TERMINUS_RESET"] == "1" {
                TokenStore.clear()
                // Not the code last tried: the phone's context still holds it, spent, and it would be tried again.
                for k in Shared.defaults.dictionaryRepresentation().keys where k != "watch.triedCode" {
                    Shared.defaults.removeObject(forKey: k)
                }
                Shared.lastAnswer = nil
                Shared.lastNearby = nil
            }
            if let t = env["TERMINUS_TOKEN"], !t.isEmpty { TokenStore.save(t) }
            if let l = env["TERMINUS_LANG"] { Lang.pref = l }
        }
    }
#endif
