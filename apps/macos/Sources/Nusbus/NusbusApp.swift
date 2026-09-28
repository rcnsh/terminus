import SwiftUI

/// Creates the model at launch, so refreshing starts even before (or
/// without) SwiftUI ever drawing the menu bar item.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let dir = ProcessInfo.processInfo.environment["NUSBUS_SNAPSHOT"] {
            MainActor.assumeIsolated { Snapshots.render(to: dir) }
            exit(0)
        }
        #endif
        MainActor.assumeIsolated { _ = AppModel.shared }
    }
}

@main
struct NusbusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            Popover(model: model)
        } label: {
            if let title = model.menuTitle {
                Label(title, systemImage: "bus.fill").labelStyle(.titleAndIcon)
            } else {
                Image(systemName: "bus.fill")
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Shell

struct Popover: View {
    @Bindable var model: AppModel
    /// Drives the opening animation. The popover's window is the only one
    /// this app has, so its key state is exactly "the popover is open".
    @State private var shown: Bool

    init(model: AppModel, startShown: Bool = false) {
        self.model = model
        _shown = State(initialValue: startShown)
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if model.paired { Main(model: model, shown: shown) } else { Pair(model: model, shown: shown) }
            }
            .padding(14)
            Footer(model: model)
        }
        .frame(width: 360)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in open() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { _ in close() }
        .onAppear { open() }
    }

    private func open() {
        guard !shown else { return }
        model.popoverOpen = true
        withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) { shown = true }
    }

    private func close() {
        model.popoverOpen = false
        shown = false
    }
}

/// Each section fades up into place, a beat after the one above it.
private struct Entrance: ViewModifier {
    let shown: Bool
    let order: Int

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 10)
            .scaleEffect(shown ? 1 : 0.98, anchor: .top)
            .animation(.spring(response: 0.45, dampingFraction: 0.8).delay(Double(order) * 0.045), value: shown)
    }
}

private extension View {
    func entrance(_ shown: Bool, _ order: Int) -> some View { modifier(Entrance(shown: shown, order: order)) }

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
    let shown: Bool
    @State private var code = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconTile(system: "bus.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("nusbus").font(.system(size: 17, weight: .semibold))
                    StatusLine(color: .gray, text: "Not paired")
                }
            }
            .card()
            .entrance(shown, 0)

            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Pair this Mac")
                Text("On nusbus.rcn.sh/account, click \u{201C}Get a pairing code\u{201D} and type it here.")
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
            .entrance(shown, 1)
        }
    }
}

// MARK: - Main

private struct Main: View {
    @Bindable var model: AppModel
    let shown: Bool
    @State private var query = ""

    private var answer: NextAnswer? { model.shown }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Header(model: model).entrance(shown, 0)

            if model.needsLocation {
                HStack(spacing: 10) {
                    Image(systemName: "location.fill").foregroundStyle(.blue)
                    Text("Start from the stop you're nearest").font(.callout)
                    Spacer()
                    Button("Allow") { model.askLocation() }.controlSize(.small)
                }
                .card(padding: 10)
                .entrance(shown, 1)
            }

            Tabs(model: model).entrance(shown, 1)

            // Fixed minimum height: switching tabs never resizes the popover.
            ZStack(alignment: .top) {
                if model.showNearby {
                    NearbyList(stops: model.nearby).transition(.opacity.combined(with: .offset(y: 6)))
                } else {
                    AnswerDetail(answer: answer).transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .top)
            .animation(.snappy(duration: 0.22), value: model.showNearby)
            .animation(.snappy(duration: 0.22), value: model.target)
            .entrance(shown, 2)

            Search(model: model, query: $query).entrance(shown, 3)
        }
    }
}

/// The hero: where you're going, the answer, and whether it's live.
private struct Header: View {
    @Bindable var model: AppModel

    var body: some View {
        let a = model.showNearby ? model.plan : model.shown
        HStack(alignment: .center, spacing: 12) {
            IconTile(system: model.showNearby ? "location.fill" : "bus.fill")
            VStack(alignment: .leading, spacing: 3) {
                Text(heading(a))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(model.showNearby ? "Departures near you" : (a?.label ?? "Checking…"))
                    .font(.system(size: 20, weight: .bold, design: .rounded))
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                StatusLine(color: dotColor(model.showNearby ? nil : a?.quality), text: status(a))
            }
            Spacer(minLength: 0)
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(model.loading ? 360 : 0))
                    .animation(model.loading ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: model.loading)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.primary.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .help("Refresh")
        }
        .card()
        .animation(.snappy(duration: 0.25), value: a?.label)
    }

    private func heading(_ a: NextAnswer?) -> String {
        if model.showNearby { return "Nearby" }
        guard let a else { return "Next bus" }
        if a.mode == "nearby" { return "Nearby" }
        guard let d = a.dest else { return "Next bus" }
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
        let when = model.updated.map { " · \($0.formatted(date: .omitted, time: .shortened))" } ?? ""
        if model.showNearby { return "Updated" + when }
        switch a?.quality {
        case "live": return "Live" + when
        case "scheduled": return "Timetable estimate" + when
        case "stale": return "A few minutes old" + when
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
    var body: some View {
        Image(systemName: system)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.orange)
            .frame(width: 42, height: 42)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(.orange.opacity(0.16)))
            .contentTransition(.symbolEffect(.replace))
    }
}

private struct StatusLine: View {
    let color: Color
    let text: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

// MARK: - Tabs

private struct Tabs: View {
    @Bindable var model: AppModel
    @Namespace private var pill

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
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { choose(tab) }
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
                Row(icon: "text.alignleft", text: a.detail)
                if let alt = a.alt { Row(icon: "arrow.triangle.branch", text: "Or: \(alt)") }
                if !a.stop.name.isEmpty { Row(icon: "mappin.circle", text: "Board at \(a.stop.name)") }
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

/// One pill per service: "D2  4m".
private struct FlowPills: View {
    let rows: [BoardRow]
    var body: some View {
        HStack(spacing: 6) {
            ForEach(rows, id: \.self) { r in
                HStack(spacing: 5) {
                    Text(r.svc).font(.system(size: 11, weight: .bold))
                    Text(eta(r))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
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
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.primary.opacity(0.08)))

            let q = query.trimmingCharacters(in: .whitespaces)
            if q.count >= 2 {
                let matches = model.destinations
                    .filter { $0.label.localizedCaseInsensitiveContains(q) || $0.code.localizedCaseInsensitiveContains(q) }
                    .sorted { a, b in
                        let ax = a.code.caseInsensitiveCompare(q) != .orderedSame, bx = b.code.caseInsensitiveCompare(q) != .orderedSame
                        if ax != bx { return !ax }
                        if (a.kind == "room") != (b.kind == "room") { return b.kind == "room" }
                        return a.label.count < b.label.count
                    }
                    .prefix(5)
                VStack(spacing: 0) {
                    ForEach(Array(matches), id: \.self) { d in
                        Button {
                            query = ""
                            model.select(.code(d.code, label: d.kind == "stop" ? d.label : d.code))
                        } label: {
                            HStack {
                                Image(systemName: d.kind == "stop" ? "bus" : "building.2").foregroundStyle(.secondary).frame(width: 16)
                                Text(d.label == d.code ? d.code : d.label)
                                Spacer()
                                if d.label != d.code { Text(d.code).font(.caption).foregroundStyle(.secondary) }
                            }
                            .padding(.vertical, 6)
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

// MARK: - Footer

private struct Footer: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack {
            if model.paired {
                Menu {
                    Toggle("Open at login", isOn: $model.openAtLogin)
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
