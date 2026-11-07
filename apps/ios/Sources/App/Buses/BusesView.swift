import SwiftUI
import UIKit

/// The Stops tab, called Stops: a search, then the pinned stops in one card
/// that swipes from stop to stop, each as Nearby shows it, then every line
/// with its buses out. A row opens its service's line; a stop on the line,
/// or found in the search, opens its board. The stops around you are Now's
/// Nearby. As Android's BusesScreen, in the hour's sky.
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
    @Environment(\.scenePhase) private var phase
    @State private var query = ""
    /// The list of lines has been on screen: its buses out are asked for from then.
    @State private var linesSeen = false
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
                    .column()
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
                        ServiceList(seen: $linesSeen)
                    }
                    .column()
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
        // The pinned stop showing and its neighbours, at most every 15 s (the
        // API's own cache); none while searching or with a page over the home.
        .busRefreshing(searching ? "searching" : "pins:\(model.shownPins):\(model.pinFocus ?? "")") {
            if !searching { await model.refreshPinned() }
        }
        // The lines' buses out, from when the list is first on screen, at most once a minute
        // while the home is (it reads every service from NUS); none with a page over it.
        .task(id: "\(phase == .active)|\(searching)|\(linesSeen)") {
            guard phase == .active, !searching, linesSeen else { return }
            while !Task.isCancelled {
                let wait = max(BusLines.wait(last: model.linesAskedAt, now: Date()), Quiet.wait())
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                if Task.isCancelled { return }
                await model.refreshLines()
            }
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

/// The pinned stops, in one card that swipes; with nothing pinned, how to pin one.
private struct PinnedStops: View {
    @Environment(BusesModel.self) private var model

    var body: some View {
        SectionLabel(L("Pinned")).padding(.top, 20).padding(.bottom, 4)
        switch model.pinsState {
        case .loading:
            StopSignSkeleton().shimmering().skeletonSpoken().padding(.top, 4)
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
                PinnedPager(pins: pins)
            }
        }
    }
}

/// The pinned stops' names, then one card at a time: each stop as Nearby
/// shows it, and last, how to pin another. A swipe moves the chosen name, a
/// tap on a name moves the card. The card is as tall as the page showing,
/// as on Android, so a stop with two services has no gap under it; what's
/// below moves, animated, when the page changes.
private struct PinnedPager: View {
    let pins: [String]
    @Environment(BusesModel.self) private var model
    /// Each page's own height, by its id: a stop's code or the last page's.
    @State private var heights: [String: CGFloat] = [:]

    /// The pages' gutters: the home's own, so a page sliding in comes from the screen's edge.
    private static let gutter: CGFloat = 16

    var body: some View {
        @Bindable var model = model
        let page = BusPinned.page(pins, selected: model.pinSelected)
        VStack(alignment: .leading, spacing: 10) {
            PinSegments(codes: pins, names: pins.map(model.pinName), selected: page) { code in
                withAnimation(.snappy) { model.pinSelected = code }
            }
            NearbySigns(inset: 2 * Self.gutter) { cols in
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(pins, id: \.self) { code in
                            sign(code, cols)
                                .fixedSize(horizontal: false, vertical: true)
                                .onGeometryChange(for: CGFloat.self) {
                                    $0.size.height
                                } action: {
                                    heights[code] = $0
                                }
                                .padding(.horizontal, Self.gutter)
                                .containerRelativeFrame(.horizontal)
                                .id(code)
                        }
                        AddPin()
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) {
                                $0.size.height
                            } action: {
                                heights[BusPinned.addPage] = $0
                            }
                            .padding(.horizontal, Self.gutter)
                            .containerRelativeFrame(.horizontal)
                            .id(BusPinned.addPage)
                    }
                    // The other pages are drawn past it, clipped by the scroll view.
                    .frame(height: page.flatMap { heights[$0] }, alignment: .top)
                    .animation(.snappy, value: page)
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .scrollPosition(id: $model.pinSelected)
            }
            .padding(.horizontal, -Self.gutter)
        }
    }

    /// A pinned stop's page: its sign as Nearby draws it, its times counted
    /// down while refreshes fail; or its plate alone while it's asked for.
    private func sign(_ code: String, _ cols: NearbyColumns) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let answered = model.pinnedStop(code, now: ServerClock.now)
            let stop = answered ?? NearbyStop(placeholder: code, name: model.pinName(code))
            let cells = stop.board.filter(\.running).map(NearbyCells.cells)
            let note =
                answered != nil
                ? L("No buses are running here now")
                : model.pinnedMissing.contains(code)
                    ? L("No live data")
                    : model.pinnedFailed.contains(code)
                        ? L("Couldn't reach terminus. Check your connection and try again.") : nil
            // Still on its way: its rows in bars, a badge for each service the campus data says calls there.
            let pending = note == nil ? model.campus?.stop(code)?.services ?? [] : nil
            VStack(alignment: .leading, spacing: 8) {
                StopSign(
                    stop: stop, cells: cells, cols: cols, note: note, pending: pending, listsStopped: answered != nil,
                    onStop: { model.path.append(.stop(code)) }
                ) {
                    svc in
                    model.path.append(.line(svc: svc, from: code))
                }
                // As under Nearby's signs and the web's pinned card: what a "~" means, only while one is showing.
                if cells.joined().contains(where: { $0.mark == "~" }) {
                    Text(L("~ is a guess from the timetable, not a live time."))
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                        .padding(.horizontal, 6)
                }
            }
        }
    }
}

/// The pinned stops' names over the card, the one showing raised, as the
/// stop page's "This side | Across the road". Side by side, each as wide as
/// the widest, when they fit; else in a row that scrolls, the chosen one kept in view.
private struct PinSegments: View {
    let codes: [String]
    let names: [String]
    let selected: String?
    let onSelect: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ViewThatFits(in: .horizontal) {
                EvenRow(spacing: 4) { segments(fill: true) }
                    .segmentTrack()
                ScrollView(.horizontal) {
                    HStack(spacing: 4) { segments(fill: false) }
                        .segmentTrack()
                }
                .scrollIndicators(.hidden)
            }
            .onChange(of: selected) {
                guard let selected else { return }
                withAnimation(.snappy) { proxy.scrollTo(selected, anchor: .center) }
            }
            .onAppear { if let selected { proxy.scrollTo(selected, anchor: .center) } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
    }

    private func segments(fill: Bool) -> some View {
        ForEach(Array(codes.enumerated()), id: \.element) { i, code in
            Segment(text: names[i], on: code == selected, lines: 1, wide: fill) { onSelect(code) }
                .id(code)
                .accessibilityIdentifier("pinned-\(code)")
        }
    }
}

/// Side by side, each as wide as the widest needs, sharing any room left equally.
private struct EvenRow: Layout {
    var spacing: CGFloat

    private func width(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        let gaps = spacing * CGFloat(max(0, subviews.count - 1))
        let need = (subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0) * CGFloat(subviews.count) + gaps
        guard let w = proposal.width, w.isFinite else { return need }
        return max(need, w)
    }

    private func column(_ width: CGFloat, _ count: Int) -> CGFloat {
        count == 0 ? 0 : (width - spacing * CGFloat(count - 1)) / CGFloat(count)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = width(proposal, subviews)
        let col = column(w, subviews.count)
        let h = subviews.map { $0.sizeThatFits(ProposedViewSize(width: col, height: nil)).height }.max() ?? 0
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let col = column(bounds.width, subviews.count)
        for (i, v) in subviews.enumerated() {
            v.place(
                at: CGPoint(x: bounds.minX + CGFloat(i) * (col + spacing), y: bounds.minY), anchor: .topLeading,
                proposal: ProposedViewSize(width: col, height: bounds.height))
        }
    }
}

/// The last page: how to pin another stop.
private struct AddPin: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "star").font(.title3.weight(.semibold)).foregroundStyle(Color.muted).accessibilityHidden(true)
            Text(L("Pin another stop")).font(.headline).foregroundStyle(Color.ink)
            Text(L("Tap the star on a stop in Nearby or on its page to keep it here."))
                .font(.subheadline)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 18)
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity, minHeight: 180)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(
                Color.line, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pinned-add")
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

/// Every shuttle service, each opening its whole line: its name, the stops
/// it passes, and how many of its buses are out (BusesHome asks, once a minute).
private struct ServiceList: View {
    /// Set once the list is on screen.
    @Binding var seen: Bool
    @Environment(BusesModel.self) private var model
    /// The widest badge, so every one is as wide.
    @State private var badge: CGFloat = 0

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            SectionLabel(L("Services")).fixedSize()
            Spacer(minLength: 0)
            Text(L("Tap one to see its whole line.")).font(.footnote).foregroundStyle(Color.muted).multilineTextAlignment(.trailing)
        }
        .padding(.top, 28)
        .padding(.bottom, 8)
        if let campus = model.campus {
            // The window's height, to tell when the list has come up onto it.
            let screen = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.bounds.height ?? 800
            VStack(spacing: 0) {
                ForEach(Array(campus.services.enumerated()), id: \.element) { i, svc in
                    if i > 0 { Divider().overlay(Color.line) }
                    let route = campus.routes[svc]
                    let name = route.flatMap { BusLines.name($0, stopName: { campus.stop($0)?.fullName ?? $0 }) }
                    let count = model.lineCounts[svc]
                    Button {
                        model.path.append(.line(svc: svc, from: nil))
                    } label: {
                        row(svc, color: campus.color(svc), name: name, via: route?.via, count: count)
                    }
                    .buttonStyle(BusRowPress())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(BusLines.spoken(svc: svc, name: name, via: route?.via, count: count))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint(L("See the %@ line", svc))
                    .accessibilityIdentifier("service-\(svc)")
                }
            }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .onGeometryChange(for: Bool.self) {
                let f = $0.frame(in: .global)
                return f.minY < screen && f.maxY > 0
            } action: {
                if $0 { seen = true }
            }
        } else {
            skeleton
        }
    }

    /// The list's shape while the services are on their way: six rows of bars
    /// in the loaded rows' boxes, the chevron real, as the list will have it.
    private var skeleton: some View {
        VStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { i in
                if i > 0 { Divider().overlay(Color.line) }
                HStack(spacing: 12) {
                    SkeletonBar(width: 46, height: 32, radius: 9)
                    VStack(alignment: .leading, spacing: 2) {
                        SkeletonLine(font: .body.weight(.semibold), fraction: SkeletonWidths.name(i))
                        SkeletonLine(font: .subheadline, fraction: SkeletonWidths.sub(i))
                    }
                    Spacer(minLength: 8)
                    SkeletonBar(width: 44, height: 12)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.line)
                }
                .padding(.leading, 14)
                .padding(.trailing, 10)
                .padding(.vertical, 10)
                .frame(minHeight: 56)
            }
        }
        .shimmering()
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
        .skeletonSpoken()
    }

    private func row(_ svc: String, color: String?, name: String?, via: String?, count: LineCount?) -> some View {
        HStack(spacing: 12) {
            BusChip(svc: svc, color: color, width: badge)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    badge = max(badge, $0)
                }
            VStack(alignment: .leading, spacing: 2) {
                if let name { Text(verbatim: name).font(.body.weight(.semibold)).foregroundStyle(Color.ink) }
                if let via { Text(verbatim: via).font(.subheadline).foregroundStyle(Color.muted) }
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let count {
                HStack(spacing: 6) {
                    if BusLines.showsDot(count) { BusLiveDot() }
                    Text(verbatim: count.outText).font(.subheadline).foregroundStyle(Color.muted)
                }
                .fixedSize()
            }
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
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
        .column()
        .padding(.bottom, 24)
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
            BusBoardCard(
                board: board, failed: model.failed.contains(shown), colors: model.campus?.colors ?? [:],
                services: model.campus?.stop(shown)?.services ?? []
            ) { row in
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
    let options: [String]
    let selected: Int
    let onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, text in
                Segment(text: text, on: i == selected) { onSelect(i) }
                    .accessibilityIdentifier("side-\(i)")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .segmentTrack()
    }
}

/// One choice in a row of them, raised when it's the one chosen: the stop
/// page's sides, the home's pinned stops. `wide`: as wide as it's given.
private struct Segment: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let text: String
    let on: Bool
    var lines = 2
    var wide = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: text)
                .font(.subheadline.weight(on ? .bold : .medium))
                .foregroundStyle(on ? Color.ink : Color.muted)
                .multilineTextAlignment(.center)
                .lineLimit(typeSize.isAccessibilitySize ? lines * 2 : lines)
                .padding(.vertical, 9)
                .padding(.horizontal, wide ? 8 : 14)
                .frame(maxWidth: wide ? .infinity : nil, maxHeight: .infinity)
                .background(on ? Color.surface : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .shadow(color: .black.opacity(on ? 0.08 : 0), radius: 2, y: 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }
}

extension View {
    /// The well a row of segments sits in.
    fileprivate func segmentTrack() -> some View {
        padding(4)
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
                        BusStopHeader(code: code).column()
                    }
                }
                .busBandEnd()
                BusStopBody(code: code).column().padding(.bottom, 24)
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
