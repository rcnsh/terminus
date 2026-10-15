import SwiftUI
import UIKit

/// The Buses tab: a search, then pages to swipe between, the nearest stop
/// and each pinned one, each with its board. A row opens its service's
/// line; a stop on the line, or found in the search, opens its board.
/// As Android's BusesScreen, in the hour's sky.
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
        // A stop picked elsewhere (Now's nearby stops): its board, over the tab's home.
        .onChange(of: app.openStop) { openPicked() }
        .onChange(of: app.openLine) { openPicked() }
    }

    private func openPicked() {
        if let code = app.openStop {
            app.openStop = nil
            model.sync()
            model.path = [.stop(code)]
        } else if let svc = app.openLine {
            app.openLine = nil
            model.sync()
            model.path = [.line(svc: svc, from: nil)]
        }
    }

    #if DEBUG
        /// TERMINUS_OPEN_STOP=<code>: a stop picked as Now would pick it, at
        /// launch, before the tab has shown, for the UI tests.
        init() {
            guard let code = ProcessInfo.processInfo.environment["TERMINUS_OPEN_STOP"], !BusesView.debugOpened else { return }
            BusesView.debugOpened = true
            DispatchQueue.main.async {
                AppModel.shared.openStop = code
                NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.buses)
            }
        }

        @MainActor private static var debugOpened = false
    #endif
}

/// A short note at the top, where the pull was: how it went, or the pins full.
private struct NoteView: View {
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

private let nearestID = "·nearest"

struct BusesHome: View {
    @Environment(BusesModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    @State private var query = ""
    @FocusState private var focused: Bool
    @State private var page: String? = nearestID
    @State private var pull = SkyPull()
    private let sky = SkyClock.shared

    private var searching: Bool { focused || !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var pages: [String?] { BusPins.pages(nearest: model.nearest?.code, pins: model.pins) }
    private var ids: [String] { pages.map { $0 ?? nearestID } }
    private var index: Int { ids.firstIndex(of: page ?? nearestID) ?? 0 }
    /// The stop on the page in view; nil for the nearest stop's.
    private var current: String? { index == 0 ? nil : pages[index] }

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
                            headers.padding(.top, 8)
                            if pages.count > 1 { dots.padding(.top, 10) }
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
                    pager
                }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .background(Color.page)
        .skyPull(pull, enabled: !searching, livery: model.livery(current), scene: { .hill($0) }) { [current] in
            await model.pullPage(current)
        }
        .toolbar(.hidden, for: .navigationBar)
        .busSkyChrome(strip: true)
        // The page in view only: swiping past one doesn't ask for it. The
        // nearest stop's twin comes with it, so across the road costs nothing more.
        .busRefreshing(searching ? "searching" : "page:\(current ?? nearestID):\(model.across.sorted())") {
            if !searching { await model.refreshPage(current) }
        }
        .onChange(of: ids) { _, new in
            if let p = page, !new.contains(p) { page = nearestID }
        }
    }

    // MARK: the headers in the sky

    /// The page in view's header; every header laid out under it, unseen, so
    /// the band is as tall as the longest name and doesn't jump on a swipe.
    private var headers: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(ids.enumerated()), id: \.element) { i, _ in
                PageHeader(index: i, code: pages[i]).hidden().accessibilityHidden(true)
            }
            PageHeader(index: index, code: pages[index])
                .id(ids[index])
                .transition(.opacity)
        }
        .animation(.easeOut(duration: 0.2), value: index)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        // The name swipes as the board does.
        .simultaneousGesture(
            DragGesture(minimumDistance: 24).onEnded { g in
                guard abs(g.translation.width) > abs(g.translation.height) else { return }
                let to = g.translation.width < -40 ? index + 1 : g.translation.width > 40 ? index - 1 : index
                guard to != index, ids.indices.contains(to) else { return }
                withAnimation(.snappy) { page = ids[to] }
            })
    }

    /// The pages as dots, the one in view long; the nearest stop's an arrow.
    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(Array(ids.enumerated()), id: \.element) { i, _ in
                if i == 0 {
                    Image(systemName: "location.fill").font(.system(size: 9, weight: .bold))
                        .foregroundStyle(index == 0 ? inks.ink : inks.muted.opacity(0.6))
                } else {
                    Capsule().fill(i == index ? inks.ink : inks.muted.opacity(0.45))
                        .frame(width: i == index ? 18 : 6, height: 6)
                }
            }
        }
        .animation(.snappy, value: index)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Page %@ of %@", "\(index + 1)", "\(ids.count)"))
        .accessibilityAdjustableAction { d in
            let to = d == .increment ? index + 1 : index - 1
            if ids.indices.contains(to) { withAnimation { page = ids[to] } }
        }
    }

    private var inks: Inks { Inks.sky(light: SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk) }

    // MARK: the boards

    private var pager: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(ids.enumerated()), id: \.element) { i, id in
                    VStack(alignment: .leading, spacing: 0) {
                        if let code = pages[i] {
                            BusStopBody(code: code)
                        } else {
                            NoNearest()
                        }
                        if i + 1 < ids.count, let next = pages[i + 1] {
                            SwipeFor(name: model.stopName(next)) { withAnimation(.snappy) { page = ids[i + 1] } }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                    // Its own height, not the tallest page's: a short board isn't stretched.
                    .fixedSize(horizontal: false, vertical: true)
                    .containerRelativeFrame(.horizontal)
                    .id(id)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $page)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }
}

/// Page `index`'s header in the sky: the nearest stop (`code` nil until it's known) or a pinned one.
private struct PageHeader: View {
    let index: Int
    let code: String?
    @Environment(BusesModel.self) private var model
    @Environment(\.inks) private var inks

    var body: some View {
        if let code {
            let label: String =
                index == 0
                ? (model.located
                    ? (model.boards[code]?.distM.map { L("Nearest stop · %@ m", "\($0)") } ?? L("Nearest stop")) : L("Your home stop"))
                : L("Pinned")
            let plain = index == 0 ? (model.located ? L("Nearest stop") : L("Your home stop")) : label
            BusStopHeader(code: code, label: label, plainLabel: plain, nearest: index == 0 && model.located)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Nearest stop")).font(.subheadline).foregroundStyle(inks.muted)
                Text(model.nearestState == .loading ? L("Checking…") : L("Find your stop"))
                    .font(.title.weight(.heavy))
                    .foregroundStyle(inks.ink)
                    .accessibilityAddTraits(.isHeader)
            }
            .padding(.top, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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

/// Page one without a nearest stop: no location and no home stop, or no answer.
private struct NoNearest: View {
    @Environment(BusesModel.self) private var model
    private let locator = Locator.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.nearestState {
            case .loading:
                EmptyView()
            case .failed:
                Text(L("Couldn't reach terminus. Check your connection and try again.")).foregroundStyle(Color.muted)
                Button(L("Try again")) { Task { await model.refreshNearest(force: true) } }
                    .buttonStyle(ChipButtonStyle())
            default:
                VStack(alignment: .leading, spacing: 12) {
                    Text(
                        locator.allowed
                            ? L("Search for a stop above and pin it with the star, so it's here next time.")
                            : L("Allow location to see the stop nearest you, or search for a stop and pin it with the star.")
                    )
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    if !locator.allowed {
                        Button(L("Allow location")) {
                            if locator.undecided {
                                locator.ask()
                            } else if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .buttonStyle(ChipButtonStyle(filled: true))
                        .accessibilityIdentifier("buses-allow-location")
                    }
                }
                .cardStyle()
            }
        }
        .padding(.top, 16)
        .onChange(of: locator.allowed) { _, on in
            if on { Task { await model.refreshNearest(force: true) } }
        }
    }
}

/// The next page's name, to go to it without swiping.
private struct SwipeFor: View {
    let name: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(busBold: name, in: L("Swipe for %@", name)).foregroundStyle(Color.muted).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").foregroundStyle(Color.muted).accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
        }
        .buttonStyle(.plain)
        .padding(.top, 16)
        .accessibilityIdentifier("buses-swipe-for")
    }
}

// MARK: a stop's page

/// A stop's header, in the sky: what it is ("Nearest stop · 40 m", "Pinned"),
/// its name, its code and the star. Across the road, the stop shown is the
/// twin, and the star is for that one.
struct BusStopHeader: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let code: String
    let label: String?
    /// The label across the road, where the distance is the other stop's.
    let plainLabel: String?
    let nearest: Bool
    @Environment(BusesModel.self) private var model
    @Environment(\.inks) private var inks

    var body: some View {
        let opposite = model.boards[code]?.opposite
        let across = opposite != nil && model.across.contains(code)
        let shown = across ? opposite! : code
        let starred = model.pins.contains(shown)
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                if let label {
                    HStack(spacing: 6) {
                        if nearest && !across { Image(systemName: "location.fill").font(.caption).foregroundStyle(inks.smallAccent) }
                        Text(across ? (plainLabel ?? "") : label).font(.subheadline).foregroundStyle(inks.muted)
                    }
                }
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

/// A stop opened from the search or a line: its page, with Back.
struct BusStopPage: View {
    let code: String
    @Environment(BusesModel.self) private var model
    @State private var pull = SkyPull()

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                SkyBand(moonLow: true) {
                    let label = model.pins.contains(code) ? L("Pinned") : nil
                    VStack(alignment: .leading, spacing: 0) {
                        PullRoom(below: 8)
                        BusStopHeader(code: code, label: label, plainLabel: label, nearest: false).padding(.horizontal, 16)
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
