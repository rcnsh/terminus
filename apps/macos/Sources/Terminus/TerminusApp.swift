import SwiftUI
import os

/// Creates the model at launch, so refreshing starts even before (or
/// without) SwiftUI ever drawing the menu bar item.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let dir = ProcessInfo.processInfo.environment["TERMINUS_SNAPSHOT"] {
            MainActor.assumeIsolated { Snapshots.render(to: dir) }
            exit(0)
        }
        #endif
        MainActor.assumeIsolated { _ = AppModel.shared }
    }
}

@main
struct TerminusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            Popover(model: model)
        } label: {
            // Recomputed from the departure time on the model's 30 s clock,
            // so the menu bar never shows a count that was true two refreshes
            // ago. (A TimelineView here starves app launch.)
            if model.resting {
                Image(systemName: "moon.zzz.fill")
            } else if let title = model.menuTitle(at: model.clock) {
                Label(title, systemImage: "bus.fill").labelStyle(.titleAndIcon)
            } else {
                Image(systemName: "bus.fill")
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Shell

/// A fixed "now" for snapshot renders, which can't run a TimelineView.
struct FixedNowKey: EnvironmentKey { static let defaultValue: Date? = nil }
extension EnvironmentValues {
    var fixedNow: Date? {
        get { self[FixedNowKey.self] }
        set { self[FixedNowKey.self] = newValue }
    }
}

/// Re-renders its content every `every` seconds with the current time.
struct Ticking<Content: View>: View {
    let every: TimeInterval
    @ViewBuilder let content: (Date) -> Content
    @Environment(\.fixedNow) private var fixedNow

    var body: some View {
        if let fixedNow {
            content(fixedNow)
        } else {
            TimelineView(.periodic(from: .now, by: every)) { ctx in content(ctx.date) }
        }
    }
}


struct Popover: View {
    @Bindable var model: AppModel
    /// Drives the opening animation. The popover's window is the only one
    /// this app has, so its key state is exactly "the popover is open".
    @State private var shown: Bool
    @State private var window: NSWindow?

    init(model: AppModel, startShown: Bool = false) {
        self.model = model
        _shown = State(initialValue: startShown)
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if model.paired { Main(model: model) } else { Pair(model: model) }
            }
            .padding(14)
            Footer(model: model)
        }
        .frame(width: 360)
        .fixedSize(horizontal: false, vertical: true)
        // The menu bar window grows to fit taller content but never shrinks
        // back on its own, leaving the shorter content centred with a gap
        // above it. Measure the content and size the window to it, top edge
        // pinned under the menu bar.
        .background(GeometryReader { g in Color.clear.preference(key: ContentHeight.self, value: g.size.height) })
        .onPreferenceChange(ContentHeight.self) { h in fit(height: h) }
        .background(WindowReader { if window !== $0 { window = $0 } })
        // Opening is a plain fade of the whole popover; nothing moves.
        .opacity(shown ? 1 : 0)
        .frame(maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea()
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { n in
            if window == nil || n.object as? NSWindow === window { open() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { n in
            if n.object as? NSWindow === window { close() }
        }
        // The definitive "it's gone": the window stops being visible.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { n in
            guard let w = n.object as? NSWindow, w === window, !w.occlusionState.contains(.visible) else { return }
            model.popoverOpen = false
            shown = false
        }
        .onAppear { open() }
    }

    private func open() {
        guard !shown else { return }
        model.popoverOpen = true
        withAnimation(.easeOut(duration: 0.18)) { shown = true }
    }

    /// Losing key status doesn't mean the popover closed: opening the
    /// Settings menu takes key away while the popover stays on screen. Only
    /// treat it as closed once the window has actually gone.
    private func close() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            guard let window, !window.isVisible || !window.occlusionState.contains(.visible) else { return }
            model.popoverOpen = false
            shown = false
        }
    }

    private func fit(height: CGFloat) {
        guard let window, height > 0 else { return }
        let content = window.contentRect(forFrameRect: window.frame)
        guard abs(content.height - height) > 0.5 else { return }
        var frame = window.frameRect(forContentRect: NSRect(x: content.minX, y: content.minY, width: content.width, height: height))
        frame.origin.y = window.frame.maxY - frame.height
        window.setFrame(frame, display: true, animate: false)
    }
}

private struct ContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Hands back the NSWindow this view ends up in.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow) -> Void

    init(_ found: @escaping (NSWindow) -> Void) { self.found = found }

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { if let w = v.window { found(w) } }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { if let w = nsView.window { found(w) } }
    }
}

/// The site's accent (#c2410c light, #fb923c dark), so the menu bar app
/// looks like the same product as the web and the widget.
extension Color {
    static let brand = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0xFB / 255, green: 0x92 / 255, blue: 0x3C / 255, alpha: 1)
            : NSColor(red: 0xC2 / 255, green: 0x41 / 255, blue: 0x0C / 255, alpha: 1)
    })
    /// Warning amber for "tight", matching the web's --warn.
    /// "On time", matching the site's --good-ink.
    static let good = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255, alpha: 1)
            : NSColor(red: 0x16 / 255, green: 0x65 / 255, blue: 0x34 / 255, alpha: 1)
    })
    static let warn = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255, alpha: 1)
            : NSColor(red: 0xB4 / 255, green: 0x53 / 255, blue: 0x09 / 255, alpha: 1)
    })
}

/// "termi" + "nus" in the accent, as on the site.
struct Wordmark: View {
    var size: CGFloat = 17
    var body: some View {
        (Text("termi") + Text("nus").foregroundColor(.brand))
            .font(.system(size: size, weight: .semibold))
            .accessibilityLabel("terminus")
    }
}

private extension View {
    /// The inset card every section sits on.
    func card(padding: CGFloat = 12) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(0.08)))
    }
}

private struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(.secondary)
    }
}

// MARK: - Pairing

private struct Pair: View {
    @Bindable var model: AppModel
    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconTile(system: "bus.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Wordmark()
                    StatusLine(color: .gray, text: "Not paired")
                }
            }
            .card()

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Pair this Mac")
                Text("Sign in at terminus.rcn.sh/account, choose Pair a device, then enter the 6-character code here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("ABC 123", text: $code)
                    .textFieldStyle(.plain)
                    .font(.system(size: 24, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.06)))
                    .onChange(of: code) { _, v in
                        let clean = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
                        if clean != v { code = clean }
                    }
                    .onSubmit { if code.count == 6 { model.pair(code) } }
                Button {
                    model.pair(code)
                } label: {
                    Text(model.pairing ? "Pairing…" : "Pair").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(code.count != 6 || model.pairing)
                if let e = model.pairError {
                    Text(e).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
            .card()
        }
    }
}

// MARK: - Main

private struct Main: View {
    @Bindable var model: AppModel
    @State private var query = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var answer: NextAnswer? { model.shown }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Header(model: model)

            if let v = model.update {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                    Text("terminus \(v) is out").font(.callout)
                    Spacer()
                    Button("Download") { NSWorkspace.shared.open(URL(string: "https://terminus.rcn.sh/download/mac")!) }.controlSize(.small)
                }
                .card(padding: 10)
            }

            if model.needsLocation {
                HStack(spacing: 10) {
                    Image(systemName: "location.fill").foregroundStyle(.blue).accessibilityHidden(true)
                    Text("Start from the stop you're nearest").font(.callout)
                    Spacer()
                    Button("Allow") { model.askLocation() }.controlSize(.small)
                }
                .card(padding: 10)
            } else if model.locationDenied {
                // After an update the ad-hoc signature changes and macOS may
                // forget the permission; say so instead of quietly guessing.
                HStack(spacing: 10) {
                    Image(systemName: "location.slash").foregroundStyle(.secondary).accessibilityHidden(true)
                    Text("Location is off, so answers follow your timetable").font(.callout)
                    Spacer()
                    Button("Settings") { model.openLocationSettings() }.controlSize(.small)
                }
                .card(padding: 10)
            }

            Tabs(model: model)

            // Fixed minimum height: switching tabs never resizes the popover.
            ZStack(alignment: .top) {
                if model.showNearby {
                    NearbyList(stops: model.nearby).transition(.opacity.combined(with: .offset(y: 6)))
                } else {
                    AnswerDetail(answer: answer).transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .top)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.showNearby)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.target)

            Search(model: model, query: $query)
        }
    }
}

/// The hero: where you're going, the answer, and whether it's live.
private struct Header: View {
    @Bindable var model: AppModel

    var body: some View {
        let a = model.showNearby ? model.plan : model.shown
        let resting = !model.showNearby && a?.mode == "rest"
        HStack(alignment: .center, spacing: 12) {
            IconTile(
                system: model.showNearby ? "location.fill" : resting ? "moon.zzz.fill" : a?.arrived == true ? "checkmark.circle.fill" : "bus.fill",
                tint: .brand
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(heading(a))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                // Ticks every second: the countdown and the dimming are
                // computed from the departure time, never from `label`.
                Ticking(every: 1) { now in
                    let old = !model.showNearby && !resting && a?.arrived != true && model.isOld(a, at: now)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.showNearby ? "Departures near you" : (a?.isClassPlan == true ? a?.leaveHeadline(now: now) ?? big(a) : big(a)))
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(old ? .secondary : .primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        if old {
                            StatusLine(color: .gray, text: "Old times · refreshing")
                        } else if !model.showNearby, let a, a.isClassPlan, let at = a.leaveAt {
                            let left = Int(at.timeIntervalSince(now))
                            StatusLine(color: a.leaveLate ? .red : .brand, text: left <= 0 ? "Time to go" : left >= 120 ? "in \((left + 30) / 60) min" : "in \(left / 60) min \(left % 60) s")
                        } else if !model.showNearby, !resting, let a, a.hasLiveTime, let at = a.departure {
                            StatusLine(color: dotColor(a.quality), text: countdown(to: at, now: now))
                        } else {
                            StatusLine(color: resting ? .brand : dotColor(model.showNearby ? nil : a?.quality), text: resting ? restStatus : a?.arrived == true ? "You're at the stop" : status(a))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(model.loading && !reduceMotion ? 360 : 0))
                    .opacity(model.loading && reduceMotion ? 0.4 : 1)
                    .animation(model.loading && !reduceMotion ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: model.loading)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.primary.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .help("Refresh")
            .accessibilityLabel(model.loading ? "Refreshing" : "Refresh")
        }
        .card()
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// "D2 · 09:42" when there's a live departure; otherwise the label.
    private func big(_ a: NextAnswer?) -> String {
        guard let a else { return "Checking…" }
        guard a.hasLiveTime, let at = a.departure else { return a.label }
        // A timetable estimate is not a live time: mark it, as the widget does.
        return "\(a.service) · \(a.quality == "scheduled" ? "~" : "")\(campusTime(at))"
    }

    private func countdown(to at: Date, now: Date) -> String {
        let left = Int(at.timeIntervalSince(now))
        if left <= 0 { return "Leaving now" }
        return left >= 60 ? "Leaves in \(left / 60) min \(left % 60) s" : "Leaves in \(left) s"
    }

    private var restStatus: String {
        let when = model.updated.map { " · \(campusTime($0))" } ?? ""
        return "No buses until your day starts" + when
    }

    private func heading(_ a: NextAnswer?) -> String {
        if model.showNearby { return "Nearby" }
        guard let a else { return "Next bus" }
        if a.mode == "rest" { return "Off hours" }
        if a.mode == "nearby" { return "Nearby" }
        guard let d = a.dest else { return "Next bus" }
        if a.isClassPlan, let c = a.classAt { return "\(d.label) · starts \(campusTime(c))" }
        let why = switch d.why {
        case "class": "Next class"
        case "gap-home": "Long gap · home"
        case "home": "Heading home"
        default: "Going to"
        }
        return "\(why) · \(d.label)"
    }

    private func status(_ a: NextAnswer?) -> String {
        if let e = model.error { return e }
        let when = model.updated.map { " · \(campusTime($0))" } ?? ""
        if model.showNearby { return "Updated" + when }
        switch a?.quality {
        case "live": return "Live" + when
        case "scheduled": return "Timetable estimate" + when
        case "stale": return "Live data a few minutes old" + when
        case "ended": return "Services ended" + when
        case "unknown": return "No live data" + when
        default: return "Loading"
        }
    }

    private func dotColor(_ q: String?) -> Color {
        if model.error != nil { return .red }
        switch q {
        case "live": return .green
        case "scheduled", "stale": return .orange
        case nil: return model.showNearby ? .green : .gray
        default: return .gray
        }
    }
}

private struct IconTile: View {
    let system: String
    var tint: Color = .orange
    var body: some View {
        Image(systemName: system)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 42, height: 42)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(tint.opacity(0.16)))
            .contentTransition(.symbolEffect(.replace))
            .accessibilityHidden(true)
    }
}

private struct StatusLine: View {
    let color: Color
    let text: String
    var body: some View {
        HStack(spacing: 5) {
            // Colour repeats what the text says; VoiceOver gets the text.
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

// MARK: - Tabs

private struct Tabs: View {
    @Bindable var model: AppModel
    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Tab: Hashable { case plan, place(String), code(String, String), nearby }

    private var tabs: [(Tab, String, String)] {
        var out: [(Tab, String, String)] = [(.plan, "Next", "clock")]
        out += model.places.map { (.place($0.key), $0.label, "mappin") }
        if case .code(let c, let l) = model.target { out.append((.code(c, l), l, "magnifyingglass")) }
        out.append((.nearby, "Nearby", "location"))
        return out
    }

    private var current: Tab {
        if model.showNearby { return .nearby }
        switch model.target {
        case .plan: return .plan
        case .place(let k): return .place(k)
        case .code(let c, let l): return .code(c, l)
        }
    }

    var body: some View {
        // No scrolling unless the tabs genuinely don't fit.
        // Icons and text, then text only, then scroll: the first that fits.
        ViewThatFits(in: .horizontal) {
            strip(icons: true)
            strip(icons: false)
            ScrollView(.horizontal, showsIndicators: false) { strip(icons: false) }
        }
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(.primary.opacity(0.08)))
    }

    private func strip(icons: Bool) -> some View {
        HStack(spacing: 2) {
            ForEach(tabs, id: \.0) { tab, title, icon in
                let on = tab == current
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85)) { choose(tab) }
                } label: {
                    Label(title, systemImage: icon)
                        .font(.system(size: 12, weight: on ? .semibold : .medium))
                        .labelStyle(TabLabelStyle(icons: icons))
                        .foregroundStyle(on ? .primary : .secondary)
                        .fixedSize()
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(.primary.opacity(0.12))
                                    .matchedGeometryEffect(id: "pill", in: pill)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(3)
    }

    private func choose(_ tab: Tab) {
        switch tab {
        case .plan: model.select(.plan)
        case .place(let k): model.select(.place(key: k))
        case .code(let c, let l): model.select(.code(c, label: l))
        case .nearby: model.selectNearby()
        }
    }
}

private struct TabLabelStyle: LabelStyle {
    let icons: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            if icons { configuration.icon }
            configuration.title
        }
    }
}

// MARK: - Content

private struct AnswerDetail: View {
    let answer: NextAnswer?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = answer {
                if a.isClassPlan {
                    // Each arrival next to the bus it belongs to.
                    if let c = a.catchLine { Row(icon: "figure.walk", text: c).fontWeight(.semibold).foregroundStyle(a.leaveLate ? Color.red : Color.good) }
                    if let note = a.leave?.note { Row(icon: "person.3.fill", text: note).foregroundStyle(Color.warn) }
                    if a.leave?.estimated == true {
                        Row(icon: "info.circle", text: "Estimated from the usual gap between buses. Live times show nearer the time.").foregroundStyle(.secondary)
                    }
                    if let g = a.goNowLine { Row(icon: "bus", text: g) }
                    Row(icon: "text.alignleft", text: a.detail).foregroundStyle(.secondary)
                } else {
                Row(icon: a.mode == "rest" ? "calendar" : "text.alignleft", text: a.detail)
                if let leave = a.leaveText() { Row(icon: "figure.walk", text: leave).fontWeight(.semibold) }
                }
                if !a.isClassPlan, a.timing?.text != nil || crowdWord(a.crowd) != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = t.text { Pill(text: text, color: t.status == "late" ? .red : t.status == "tight" ? .warn : .good) }
                        if let c = crowdWord(a.crowd) { Pill(text: c, color: .secondary) }
                    }
                }
                if let name = a.stop?.name, !name.isEmpty { Row(icon: "mappin.circle", text: "Board at \(name)") }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }

    private struct Row: View {
        let icon: String
        let text: String
        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: icon).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 14)
                Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.14)))
    }
}

private struct NearbyList: View {
    let stops: [NearbyStop]?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let stops {
                ForEach(stops) { s in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(s.stop.name).font(.system(size: 13, weight: .semibold))
                            Spacer()
                            Text(s.walkS < 60 ? "You're here" : "\((s.walkS + 30) / 60) min walk")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        if s.board.isEmpty || !s.available {
                            Text(s.available ? "Nothing due" : "No live data").font(.caption).foregroundStyle(.secondary)
                        } else {
                            FlowPills(rows: s.board)
                        }
                    }
                    .card(padding: 10)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(.secondary)
                }
                .card()
            }
        }
    }
}

/// One pill per service: "D2  4m". Wraps onto more lines instead of
/// squeezing when a stop has many services.
private struct FlowPills: View {
    let rows: [BoardRow]
    var body: some View {
        Flow(spacing: 6) {
            ForEach(rows, id: \.self) { r in
                HStack(spacing: 5) {
                    Text(r.svc).font(.system(size: 11, weight: .bold))
                    Text(eta(r))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
                .fixedSize()
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(.primary.opacity(0.07)))
            }
        }
    }

    private func eta(_ r: BoardRow) -> String {
        guard let s = r.etaS else { return r.quality == "ended" ? "ended" : "–" }
        return s < 45 ? "now" : "\((s + 30) / 60)m"
    }
}

private struct Search: View {
    @Bindable var model: AppModel
    @Binding var query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(.secondary)
                TextField("Go somewhere else", text: $query)
                    .textFieldStyle(.plain)
                    .onChange(of: query) { _, _ in model.loadDestinations() }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.primary.opacity(0.08)))

            let q = query.trimmingCharacters(in: .whitespaces)
            if !q.isEmpty {
                let matches = rankDestinations(model.destinations, q)
                let stopName = { (code: String) in model.destinations.first { $0.kind == "stop" && $0.code == code }?.label ?? code }
                VStack(spacing: 0) {
                    ForEach(Array(matches), id: \.self) { d in
                        Button {
                            query = ""
                            model.select(.code(d.code, label: d.kind == "stop" || d.kind == "landmark" ? d.label : d.code))
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: d.kind == "stop" ? "bus" : d.kind == "room" ? "door.left.hand.open" : d.kind == "landmark" ? "fork.knife" : "building.2")
                                    .foregroundStyle(.secondary).frame(width: 16)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(d.label)
                                    Text(d.kind == "stop" ? "Bus stop" : d.kind == "landmark" ? "\(d.detail.map { "\($0) · " } ?? "")\((d.stops ?? []).map(stopName).joined(separator: " or ")) stop" : "\(d.label != d.code ? "\(d.code) · " : "")\(stopName(d.stopCode)) stop\(d.walkM.map { ", \(Swift.max(1, Int((Double($0) / 1.3 / 60).rounded()))) min walk" } ?? "")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .card(padding: 4)
                .transition(.opacity)
            }
        }
    }
}

/// Left-to-right layout that wraps to a new line when the next item
/// wouldn't fit.
private struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

// MARK: - Footer

private struct Footer: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack {
            if model.paired {
                Menu {
                    Toggle(model.misplaced ? "Open at login (move to Applications first)" : "Open at login", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
                        .disabled(model.misplaced && !model.openAtLogin)
                    Button("Refresh now") { Task { await model.refresh() } }
                    Divider()
                    Button("Unpair this Mac") { model.unpair() }
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            Spacer()
            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quit", systemImage: "power")
            }
            .buttonStyle(.plain)
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.primary.opacity(0.04))
        .overlay(alignment: .top) { Divider() }
    }
}
