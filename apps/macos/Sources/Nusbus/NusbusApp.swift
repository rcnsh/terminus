import SwiftUI

/// Creates the model at launch, so refreshing starts even before (or
/// without) SwiftUI ever drawing the menu bar item.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
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
                .onAppear { model.popoverOpen = true }
                .onDisappear { model.popoverOpen = false }
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

struct Popover: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.paired { Main(model: model) } else { Pair(model: model) }
        }
        .padding(16)
        .frame(width: 340)
    }
}

// MARK: pairing

private struct Pair: View {
    @Bindable var model: AppModel
    @State private var code = ""

    var body: some View {
        Text("nusbus").font(.title2.bold())
        Text("Pair this Mac with your account. On nusbus.rcn.sh/account, click \"Get a pairing code\" and type it here.")
            .fixedSize(horizontal: false, vertical: true)
        HStack {
            TextField("Pairing code", text: $code)
                .textFieldStyle(.roundedBorder)
                .font(.system(.title3, design: .monospaced))
                .onChange(of: code) { _, v in
                    let clean = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
                    if clean != v { code = clean }
                }
                .onSubmit { if code.count == 6 { model.pair(code) } }
            Button(model.pairing ? "Pairing…" : "Pair") { model.pair(code) }
                .disabled(code.count != 6 || model.pairing)
                .keyboardShortcut(.defaultAction)
        }
        if let e = model.pairError { Text(e).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        Divider()
        Button("Quit nusbus") { NSApplication.shared.terminate(nil) }
            .buttonStyle(.link)
    }
}

// MARK: main

private struct Main: View {
    @Bindable var model: AppModel
    @State private var query = ""

    var body: some View {
        if model.needsLocation {
            HStack {
                Text("Allow location to start from the stop you're nearest.").font(.callout)
                Spacer()
                Button("Allow") { model.askLocation() }
            }
        }

        chips

        // A fixed minimum height keeps the popover from resizing as views
        // switch or data arrives.
        Group {
            if model.showNearby {
                NearbyList(stops: model.nearby)
            } else {
                AnswerCard(answer: model.shown)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .top)

        search

        Divider()
        HStack {
            if model.loading { ProgressView().controlSize(.mini) }
            Text(footer).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Menu {
                Toggle("Open at login", isOn: $model.openAtLogin)
                Button("Refresh now") { Task { await model.refresh() } }
                Divider()
                Button("Unpair this Mac") { model.unpair() }
                Button("Quit nusbus") { NSApplication.shared.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    private var footer: String {
        let when = model.updated.map { "Updated \($0.formatted(date: .omitted, time: .shortened))" }
        return [model.error, when].compactMap { $0 }.joined(separator: " · ")
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Chip("Next", on: !model.showNearby && model.target == .plan) { model.select(.plan) }
                ForEach(model.places, id: \.key) { p in
                    Chip(p.label, on: !model.showNearby && model.target == .place(key: p.key)) { model.select(.place(key: p.key)) }
                }
                if case .code(_, let label) = model.target {
                    Chip(label, on: !model.showNearby) { model.select(model.target) }
                }
                Chip("Nearby", on: model.showNearby) { model.selectNearby() }
            }
        }
    }

    @ViewBuilder private var search: some View {
        TextField("Go somewhere else: stop, building or room", text: $query)
            .textFieldStyle(.roundedBorder)
            .onChange(of: query) { _, _ in model.loadDestinations() }
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
                .prefix(6)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(matches), id: \.self) { d in
                    Button {
                        query = ""
                        model.select(.code(d.code, label: d.kind == "stop" ? d.label : d.code))
                    } label: {
                        Text(d.label == d.code ? d.code : "\(d.label) (\(d.code))")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 5)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
        }
    }
}

private struct Chip: View {
    let title: String
    let on: Bool
    let action: () -> Void
    init(_ title: String, on: Bool, action: @escaping () -> Void) {
        self.title = title
        self.on = on
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.callout)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(on ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.1), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct AnswerCard: View {
    let answer: NextAnswer?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let a = answer {
                if let heading { Text(heading).foregroundStyle(.secondary) }
                Text(a.label).font(.title.bold())
                Text(a.detail).fixedSize(horizontal: false, vertical: true)
                if let alt = a.alt { Text("Or: \(alt)").foregroundStyle(.secondary) }
                if let note = qualityNote(a.quality) { Text(note).font(.caption).foregroundStyle(.secondary) }
            } else {
                Text("Checking…").font(.title3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private var heading: String? {
        guard let a = answer else { return nil }
        if a.mode == "nearby" { return "Nearby" }
        guard let d = a.dest else { return nil }
        return d.why == "gap-home" ? "\(d.label) · long gap" : d.label
    }

    private func qualityNote(_ q: String) -> String? {
        switch q {
        case "scheduled": "Estimated from the timetable, no live bus seen"
        case "stale": "Live data is a few minutes old"
        case "unknown": "Couldn't reach the NUS bus feed"
        default: nil
        }
    }
}

private struct NearbyList: View {
    let stops: [NearbyStop]?

    var body: some View {
        if let stops {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(stops) { s in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(s.stop.name).bold()
                            Spacer()
                            Text(s.walkS < 60 ? "here" : "\((s.walkS + 30) / 60) min walk").foregroundStyle(.secondary)
                        }
                        if !s.available { Text("No live data").font(.caption).foregroundStyle(.secondary) }
                        ForEach(s.board, id: \.self) { r in
                            HStack {
                                Text(r.svc).fontWeight(.semibold)
                                Spacer()
                                Text(eta(r)).monospacedDigit()
                            }
                        }
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                }
            }
        } else {
            Text("Checking…")
        }
    }

    private func eta(_ r: BoardRow) -> String {
        guard let s = r.etaS else { return r.quality == "ended" ? "ended" : "–" }
        return s < 45 ? "now" : "\((s + 30) / 60) min"
    }
}
