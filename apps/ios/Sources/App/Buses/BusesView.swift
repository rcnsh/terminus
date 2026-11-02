import SwiftUI
import UIKit

/// The Stops tab, called Stops: a search, then each pinned stop with the
/// top of its board, then every service. A row opens its service's line; a
/// stop on the line, or found in the search, opens its board. The stops
/// around you are Now's Nearby. As Android's BusesScreen, in the hour's sky.
struct BusesView: View {
    @State private var model = BusesModel.shared
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            BusesHome()
                .navigationDestination(for: BusRoute.self) { route in
                    switch route {
                    case .stop(let code): BusStopPage(code: code)
                    case .line(let svc, let from): BusLinePage(svc: svc, from: from)
                    }
                }
        }
        .environment(model)
        .overlay(alignment: .top) { NoteView(text: model.note) }
        .task(id: app.session) {
            model.sync()
            await model.loadCampus()
        }
        // Each time the tab shows: the pins and "public buses" may have changed in Settings.
        .onAppear {
            Task { await model.loadProfile() }
            openPicked()
        }
        // A stop or line picked elsewhere (Now's Nearby, the map): its page, over the tab's home.
        .onChange(of: app.openBuses) { openPicked() }
    }

    private func openPicked() {
        guard let pages = app.openBuses else { return }
        app.openBuses = nil
        model.sync()
        model.path = pages
    }

    #if DEBUG
        /// TERMINUS_OPEN_STOP=<code>: a stop picked as Now would pick it, at
        /// launch, before the tab has shown, for the UI tests.
        init() {
            guard let code = ProcessInfo.processInfo.environment["TERMINUS_OPEN_STOP"], !BusesView.debugOpened else { return }
            BusesView.debugOpened = true
            DispatchQueue.main.async { AppModel.shared.showInBuses([.stop(code)]) }
        }

        @MainActor private static var debugOpened = false
    #endif
}

/// A short note at the top, where the pull was: how it went, or the pins
/// full. On Now too, for Nearby's stars.
struct NoteView: View {
    let text: String?

    var body: some View {
        Group {
            if let text {
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.page)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.ink.opacity(0.92), in: Capsule())
                    .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityIdentifier("buses-note")
                    .announced(text)
            }
        }
        .animation(.snappy, value: text)
    }
}

/// Runs `action` now and every 15 s (longer while the server asked for a
/// wait), only while this is on screen and the app is in front.
struct BusRefreshing: ViewModifier {
    let id: String
    let action: () async -> Void
    @Environment(\.scenePhase) private var phase
    @Environment(BusesModel.self) private var model

    func body(content: Content) -> some View {
        content.task(id: "\(id)|\(phase == .active)") {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await action()
                let wait = max(BusTimes.refreshS, Quiet.wait())
                model.nextTimedAt = Date().addingTimeInterval(wait)
                try? await Task.sleep(for: .seconds(wait))
            }
        }
    }
}

extension View {
    func busRefreshing(_ id: String, _ action: @escaping () async -> Void) -> some View {
        modifier(BusRefreshing(id: id, action: action))
    }
}

// MARK: home

struct BusesHome: View {
    @Environment(BusesModel.self) private var model
    @State private var query = ""
    @FocusState private var focused: Bool
    @State private var pull = SkyPull()

    private var searching: Bool { focused || !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                SkyBand(moonLow: true, moon: !searching) {
                    VStack(alignment: .leading, spacing: 0) {
                        BusSearchField(query: $query, focused: $focused)
                            .padding(.top, 8)
                            .pullLead()
                        if !searching {
                            PullRoom(above: 8, below: 8)
                            HomeTitle().padding(.top, 8)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .busBandEnd()
                if searching {
                    BusSearchResults(query: query) { hit in
                        query = ""
                        focused = false
                        switch hit {
                        case .service(let s): model.path.append(.line(svc: s, from: nil))
                        case .stop(let code, _, _, _): model.path.append(.stop(code))
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        PinnedStops()
                        ServiceList()
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .background(Color.page)
        .skyPull(pull, enabled: !searching, livery: model.livery(nil), scene: { .hill($0) }) {
            await model.pullPins()
        }
        // Not shown (the title is in the sky): the Back on a page over the home.
        .navigationTitle(L("Stops"))
        .toolbar(.hidden, for: .navigationBar)
        .busSkyChrome(strip: true)
        // Every pinned board on the home, each at most every 15 s (the API's
        // own cache); none while searching or with a page over the home.
        .busRefreshing(searching ? "searching" : "pins:\(model.shownPins)") {
            if !searching { await model.refreshPins() }
        }
    }
}

/// The tab's name, large in the sky.
private struct HomeTitle: View {
    @Environment(\.inks) private var inks

    var body: some View {
        Text(L("Stops"))
            .font(.title.weight(.heavy))
            .foregroundStyle(inks.ink)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
    }
}

/// Each pinned stop: its name, which opens its page, its star, and the top
/// of its board; with nothing pinned, how to pin one.
private struct PinnedStops: View {
    @Environment(BusesModel.self) private var model

    var body: some View {
        SectionLabel(L("Pinned")).padding(.top, 20).padding(.bottom, 4)
        switch model.pinsState {
        case .loading:
            Text(L("Checking…")).foregroundStyle(Color.muted).padding(.vertical, 12)
        case .failed:
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Couldn't reach terminus. Check your connection and try again.")).foregroundStyle(Color.muted)
                Button(L("Try again")) { Task { await model.loadProfile() } }
                    .buttonStyle(ChipButtonStyle())
            }
            .padding(.vertical, 8)
        case .ready:
            let pins = model.shownPins
            if pins.isEmpty {
                NoPins()
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(pins, id: \.self) { PinnedStop(code: $0) }
                }
            }
        }
    }
}

private struct PinnedStop: View {
    let code: String
    @Environment(BusesModel.self) private var model

    var body: some View {
        let name = model.stopName(code)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Button {
                    model.path.append(.stop(code))
                } label: {
                    HStack(spacing: 6) {
                        Text(verbatim: name).font(.headline).foregroundStyle(Color.ink).multilineTextAlignment(.leading)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
                            .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(L("See this stop's buses"))
                .accessibilityIdentifier("pinned-\(code)")
                BusStar(code: code, name: name)
            }
            .padding(.leading, 4)
            BusBoardCard(
                board: model.boards[code], failed: model.failed.contains(code), colors: model.campus?.colors ?? [:],
                limit: BusWords.homeRows, onMore: { model.path.append(.stop(code)) }
            ) { row in
                model.path.append(.line(svc: row.svc, from: code))
            }
        }
    }
}

/// Nothing pinned: where the star is that pins a stop.
private struct NoPins: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "star").font(.title3.weight(.semibold)).foregroundStyle(Color.muted).accessibilityHidden(true)
            Text(L("Tap the star on any stop to keep it here: in Nearby, on the stop's page, or after searching for it."))
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(
                Color.line, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
        )
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pinned-none")
    }
}

/// Every shuttle service, each opening its whole line, with where it goes.
/// No live counts: they'd be a request per service.
private struct ServiceList: View {
    @Environment(BusesModel.self) private var model

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            SectionLabel(L("Services")).fixedSize()
            Spacer(minLength: 0)
            Text(L("Tap one to see its whole line.")).font(.footnote).foregroundStyle(Color.muted).multilineTextAlignment(.trailing)
        }
        .padding(.top, 28)
        .padding(.bottom, 8)
        if let campus = model.campus {
            VStack(spacing: 0) {
                ForEach(Array(campus.services.enumerated()), id: \.element) { i, svc in
                    if i > 0 { Divider().overlay(Color.line) }
                    Button {
                        model.path.append(.line(svc: svc, from: nil))
                    } label: {
                        row(svc, campus)
                    }
                    .buttonStyle(BusRowPress())
                    .accessibilityHint(L("See the %@ line", svc))
                    .accessibilityIdentifier("service-\(svc)")
                }
            }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        } else {
            Text(L("Checking…")).foregroundStyle(Color.muted).padding(.vertical, 12)
        }
    }

    private func row(_ svc: String, _ campus: BusCampus) -> some View {
        HStack(spacing: 12) {
            BusChip(svc: svc, color: campus.color(svc))
            if let words = campus.routes[svc].flatMap({ BusWords.route($0, name: { campus.stop($0)?.fullName ?? $0 }) }) {
                Text(verbatim: words).foregroundStyle(Color.ink).multilineTextAlignment(.leading)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint).accessibilityHidden(true)
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// A stop's star, small, beside its name on the home and on Nearby's signs:
/// filled when it's pinned. Pins or unpins it, as the star on its page does.
struct BusStar: View {
    let code: String
    let name: String
    private let model = BusesModel.shared
    @Environment(\.inks) private var inks
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let starred = model.pins.contains(code)
        Button {
            model.togglePin(code)
        } label: {
            Image(systemName: starred ? "star.fill" : "star")
                .font(.system(size: 18 * scale, weight: .semibold))
                .foregroundStyle(starred ? inks.accent : Color.muted)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(starred ? L("Unpin %@", name) : L("Pin %@", name))
        .accessibilityAddTraits(starred ? .isSelected : [])
        .accessibilityIdentifier("star-\(code)")
    }
}

/// The search over every stop and service, as glass in the sky.
private struct BusSearchField: View {
    @Binding var query: String
    var focused: FocusState<Bool>.Binding
    @Environment(\.inks) private var inks

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(inks.muted).accessibilityHidden(true)
            TextField("", text: $query, prompt: Text(L("Search a stop or service")).foregroundStyle(inks.muted))
                .focused(focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .foregroundStyle(inks.ink)
                .accessibilityLabel(L("Search a stop or service"))
                .accessibilityIdentifier("buses-search")
            if !query.isEmpty || focused.wrappedValue {
                Button {
                    query = ""
                    focused.wrappedValue = false
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(inks.muted)
                }
                .accessibilityLabel(L("Close"))
                .accessibilityIdentifier("buses-search-close")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .background(inks.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(inks.line))
    }
}

/// What the search found: services, then stops.
private struct BusSearchResults: View {
    let query: String
    let onPick: (BusHit) -> Void
    @Environment(BusesModel.self) private var model

    var body: some View {
        let campus = model.campus
        let index = campus.map(BusSearch.index) ?? []
        let hits = BusSearch.search(query, in: index)
        VStack(alignment: .leading, spacing: 0) {
            if hits.isEmpty && campus != nil {
                Text(L("No stop or service by that name")).foregroundStyle(Color.muted).padding(.vertical, 12)
            }
            ForEach(Array(hits.enumerated()), id: \.element.id) { i, hit in
                if i == 0 || hits[i - 1].isService != hit.isService {
                    SectionLabel(hit.isService ? L("Services") : L("Stops")).padding(.top, 16).padding(.bottom, 4)
                }
                Button {
                    onPick(hit)
                } label: {
                    row(hit, campus)
                }
                .buttonStyle(BusRowPress())
                .accessibilityIdentifier("hit-\(hit.id)")
                Divider().overlay(Color.line)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func row(_ hit: BusHit, _ campus: BusCampus?) -> some View {
        HStack(spacing: 12) {
            switch hit {
            case .service(let svc):
                BusChip(svc: svc, color: campus?.color(svc))
                let n = campus?.stops.filter { $0.services.contains(svc) }.count ?? 0
                if n > 0 { Text(L("%@ stops", "\(n)")).foregroundStyle(Color.muted) }
            case .stop(let code, let name, let services, _):
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: name).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                    HStack(spacing: 6) {
                        Text(verbatim: code).font(.caption.weight(.medium)).foregroundStyle(Color.muted)
                        ForEach(services, id: \.self) { BusBadge(svc: $0, color: campus?.color($0), size: 11, even: true) }
                    }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint).accessibilityHidden(true)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

// MARK: a stop's page

/// A stop's header, in the sky: "Pinned" when it is, its name, its code and
/// the star. Across the road, the stop shown is the opposite stop, and the
/// star is for that one.
struct BusStopHeader: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let code: String
    @Environment(BusesModel.self) private var model
    @Environment(\.inks) private var inks

    var body: some View {
        let opposite = model.boards[code]?.opposite
        let across = opposite != nil && model.across.contains(code)
        let shown = across ? opposite! : code
        let starred = model.pins.contains(shown)
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                if starred { Text(L("Pinned")).font(.subheadline).foregroundStyle(inks.muted) }
                Text(verbatim: model.stopName(shown))
                    .font(.title.weight(.heavy))
                    .foregroundStyle(inks.ink)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("stop-name")
                Text(verbatim: shown).font(.caption.weight(.semibold)).tracking(0.8).foregroundStyle(inks.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if model.pinsState == .ready {
                Button {
                    model.togglePin(shown)
                } label: {
                    Image(systemName: starred ? "star.fill" : "star")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(starred ? inks.accent : inks.ink)
                        .frame(width: 44, height: 44)
                        .background(inks.raised, in: Circle())
                        .overlay(Circle().strokeBorder(inks.line))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(starred ? L("Unpin this stop") : L("Pin this stop"))
                .accessibilityIdentifier("buses-pin")
            }
        }
        .padding(.top, 8)
    }
}

/// Under the sky: this side or across the road, and the board.
struct BusStopBody: View {
    let code: String
    @Environment(BusesModel.self) private var model

    var body: some View {
        let own = model.boards[code]
        let opposite = own?.opposite
        let across = opposite != nil && model.across.contains(code)
        let shown = across ? opposite! : code
        let board = model.boards[shown]
        VStack(alignment: .leading, spacing: 12) {
            if let own, let opposite {
                // Labelled from the page's own stop, so they stay put after switching. Two
                // stops only near each other (PGP and its Foyer) aren't sides of a road: their names.
                Sides(
                    options: own.oppositeAcross
                        ? [L("This side"), L("Across the road")] : [own.name, own.oppositeName ?? model.stopName(opposite)],
                    selected: across ? 1 : 0
                ) {
                    model.setAcross(code, $0 == 1)
                }
            }
            BusBoardCard(board: board, failed: model.failed.contains(shown), colors: model.campus?.colors ?? [:]) { row in
                model.path.append(.line(svc: row.svc, from: shown))
            }
            if let board { BusBoardFoot(board: board) }
        }
        .padding(.top, 12)
    }
}

/// Two choices side by side, the chosen one raised: "This side | Across the road".
/// A long stop name takes two lines, which a system segmented control can't.
private struct Sides: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let options: [String]
    let selected: Int
    let onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, text in
                let on = i == selected
                Button {
                    onSelect(i)
                } label: {
                    Text(verbatim: text)
                        .font(.subheadline.weight(on ? .bold : .medium))
                        .foregroundStyle(on ? Color.ink : Color.muted)
                        .multilineTextAlignment(.center)
                        .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                        .padding(.vertical, 9)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(on ? Color.surface : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .shadow(color: .black.opacity(on ? 0.08 : 0), radius: 2, y: 1)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isSelected] : [])
                .accessibilityIdentifier("side-\(i)")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(4)
        .background(Color.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
    }
}

/// A stop opened from the home, the search, a line or Nearby: its page, with Back.
struct BusStopPage: View {
    let code: String
    @Environment(BusesModel.self) private var model
    @State private var pull = SkyPull()

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                SkyBand(moonLow: true) {
                    VStack(alignment: .leading, spacing: 0) {
                        PullRoom(below: 8)
                        BusStopHeader(code: code).padding(.horizontal, 16)
                    }
                }
                .busBandEnd()
                BusStopBody(code: code).padding(.horizontal, 16).padding(.bottom, 24)
            }
        }
        .background(Color.page)
        .skyPull(pull, livery: model.livery(code), scene: { .hill($0) }) { await model.pullPage(code) }
        .busRefreshing("stop:\(code):\(model.across.contains(code))") { await model.refreshPage(code) }
        .skyPage(title: model.stopName(code))
    }
}

extension View {
    /// A page pushed over the tab: its sky up under a clear bar, the back
    /// button in the sky's ink, and `title` for the next page's Back.
    func skyPage(title: String) -> some View { modifier(SkyPage(title: title)) }
}

private struct SkyPage: ViewModifier {
    let title: String
    @Environment(\.colorScheme) private var scheme
    private let sky = SkyClock.shared

    func body(content: Content) -> some View {
        let light = SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk
        let page =
            content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            // The name is in the sky, large: not again in the bar.
            .toolbar { ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) } }
            .busSkyChrome(strip: false)
        if #available(iOS 26, *) {
            // The bar's buttons are glass of their own, readable over the sky and the page alike.
            page
        } else {
            // Over the sky the bar is clear, and scrolled it's a dark bar: the sky's ink reads on both.
            page.toolbarColorScheme(light ? .dark : nil, for: .navigationBar).tint(Inks.sky(light: light).ink)
        }
    }
}

/// Where a page's sky band is, as it scrolls: whether it has moved from
/// where it rests, and whether it has gone under the status bar. Only the
/// two flags change, so scrolling doesn't redraw the page every frame.
@MainActor @Observable
final class BandTracker {
    private(set) var moved = false
    private(set) var past = false
    @ObservationIgnored private var rest: CGFloat?

    func saw(top: CGFloat, bottom: CGFloat) {
        let r = rest ?? top
        if rest == nil { rest = r }
        let m = top < r - 1
        let p = bottom < r + 8
        if m != moved { moved = m }
        if p != past { past = p }
    }
}

extension View {
    /// Marks the page's sky band, so the status bar knows when it has scrolled away.
    func busBandEnd() -> some View { modifier(BandMark()) }

    /// The status bar over the sky in the sky's ink, and once the band has
    /// scrolled away, the page's; with `strip`, a bar under it once the page
    /// moves, so the board doesn't run under the clock (a pushed page has
    /// its navigation bar).
    func busSkyChrome(strip: Bool) -> some View { modifier(BusSkyChrome(strip: strip)) }
}

private struct BandMark: ViewModifier {
    @Environment(BandTracker.self) private var tracker: BandTracker?

    func body(content: Content) -> some View {
        content.background(
            GeometryReader { g in
                let f = g.frame(in: .global)
                Color.clear
                    .onAppear { tracker?.saw(top: f.minY, bottom: f.maxY) }
                    .onChange(of: f.minY) { _, _ in tracker?.saw(top: f.minY, bottom: f.maxY) }
            })
    }
}

private struct BusSkyChrome: ViewModifier {
    let strip: Bool
    @Environment(\.colorScheme) private var scheme
    @State private var band = BandTracker()
    private let sky = SkyClock.shared

    /// The status bar's height: what the strip covers.
    private var inset: CGFloat {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.safeAreaInsets.top ?? 0
    }

    func body(content: Content) -> some View {
        let lightSky = SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk
        content
            .environment(band)
            .overlay(alignment: .top) {
                // Under the clock, once the page has moved: a bar, frosted over the sky
                // in its own light or dark so the clock keeps the sky's ink, then the page's.
                if strip && band.moved {
                    Rectangle().fill(.bar)
                        .environment(\.colorScheme, band.past ? scheme : (lightSky ? .dark : .light))
                        .frame(height: inset)
                        .ignoresSafeArea(edges: .top)
                }
            }
            .statusBar(light: band.past ? scheme == .dark : (lightSky || scheme == .dark))
    }
}
