import SwiftUI
import AppKit

// MARK: - Main

struct Main: View {
    @Bindable var model: AppModel
    @Environment(\.openWindow) private var openWindow
    @State private var query = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var answer: NextAnswer? { model.shown }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Header(model: model)

            if let v = model.update {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(.orange).accessibilityHidden(true)
                    Text(L("terminus %@ is out", v)).font(.callout)
                    Spacer()
                    // Sparkle usually gets there first; this is for when it hasn't
                    // yet, or can't (a copy outside Applications).
                    if Updater.shared.running {
                        Button(L("Update")) { Updater.shared.checkNow() }.controlSize(.small)
                    } else {
                        Button(L("Download")) { NSWorkspace.shared.open(URL(string: "\(Api.site)/download/mac")!) }.controlSize(.small)
                    }
                }
                .card(padding: 10)
            }

            if model.wantsSetup {
                HStack(spacing: 10) {
                    Image(systemName: "house.fill").foregroundStyle(Color.brand).accessibilityHidden(true)
                    Text(L("Add where you live and your timetable")).font(.callout)
                    Spacer()
                    Button(L("Set up")) {
                        openWindow(id: "setup")
                        NSApp.activate()
                    }
                    .controlSize(.small)
                }
                .card(padding: 10)
            }

            if model.needsLocation {
                HStack(spacing: 10) {
                    Image(systemName: "location.fill").foregroundStyle(.blue).accessibilityHidden(true)
                    Text(L("Start from my nearest stop")).font(.callout)
                    Spacer()
                    Button(L("Allow")) { model.askLocation() }.controlSize(.small)
                }
                .card(padding: 10)
            } else if model.locationDenied {
                // Updating from an ad-hoc build (1.3.7 or earlier, or a local
                // one) can lose the permission; say so instead of quietly guessing.
                HStack(spacing: 10) {
                    Image(systemName: "location.slash").foregroundStyle(.secondary).accessibilityHidden(true)
                    Text(L("Location is off, so times are based on your timetable")).font(.callout)
                    Spacer()
                    Button(L("Settings")) { model.openLocationSettings() }.controlSize(.small)
                }
                .card(padding: 10)
            }

            Tabs(model: model)

            // Fixed minimum height: switching tabs never resizes the popover.
            ZStack(alignment: .top) {
                if model.showNearby {
                    NearbyList(stops: model.nearby).transition(.opacity.combined(with: .offset(y: 6)))
                } else if model.target == .plan, let p = model.offlinePick(at: model.clock) {
                    // Offline, the stale answer's details would mislead: how to the day plan's next thing.
                    OfflineDetail(pick: p).transition(.opacity.combined(with: .offset(y: 6)))
                } else {
                    AnswerDetail(answer: answer, busy: model.signalling, undoShownFor: model.removed?.key, onAction: model.signal, onChoice: model.choose).transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .top)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.showNearby)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.target)

            // Somewhere other than the plan: going there later today, as on the phone and the web.
            if !model.showNearby, model.target != .plan {
                GoLater(model: model)
            }

            // Today, on the plan's tab: the rest of the day under the next trip.
            if !model.showNearby, model.target == .plan, let day = model.day, !day.items.isEmpty || model.removed != nil {
                TodayList(day: day, removed: model.removed, removedAt: model.removedAt, removedBefore: model.removedBefore, failed: model.removeFailed, onRemove: model.removeFromToday, onUndo: model.undoRemove).padding(.horizontal, 4)
            }

            if model.reporting {
                ReportForm(model: model)
            } else if model.showReported {
                Text("✓ " + L("Reported, thanks")).font(.caption).foregroundStyle(.green).padding(.horizontal, 4)
            } else if !model.showNearby, answer?.card != nil {
                // One quiet line, as on the web and Android; it's in the gear menu too.
                Button(L("Is this wrong?")) { model.startReport() }
                    .buttonStyle(.link)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }

            Search(model: model, query: $query)
        }
    }
}

/// "Go later today at…": a time, then a one-off trip there, planned like a class.
struct GoLater: View {
    @Bindable var model: AppModel
    @State private var open = false
    @State private var at = Date()
    @State private var message: String?
    @State private var sending = false

    /// Half an hour from now on campus, on a five-minute mark.
    private static func soon() -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Singapore")!
        let d = Date().addingTimeInterval(30 * 60)
        let c = cal.dateComponents([.hour, .minute], from: d)
        let m = min(((c.hour ?? 0) * 60 + (c.minute ?? 0) + 4) / 5 * 5, 23 * 60 + 55)
        return cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: d) ?? d
    }

    var body: some View {
        if !open {
            Button(L("Go later today at…")) {
                at = Self.soon()
                message = nil
                open = true
            }
            .buttonStyle(.link)
            .font(.callout)
            .padding(.horizontal, 4)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    DatePicker(L("Go later today at…"), selection: $at, displayedComponents: .hourAndMinute)
                        .environment(\.timeZone, TimeZone(identifier: "Asia/Singapore")!)
                    Spacer()
                    Button(L("Cancel")) { open = false }.controlSize(.small)
                    Button(L("Plan it")) {
                        var cal = Calendar(identifier: .gregorian)
                        cal.timeZone = TimeZone(identifier: "Asia/Singapore")!
                        let c = cal.dateComponents([.hour, .minute], from: at)
                        sending = true
                        Task {
                            message = await model.goLater(atMin: (c.hour ?? 0) * 60 + (c.minute ?? 0))
                            sending = false
                            if message == nil { open = false }
                        }
                    }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(sending)
                }
                if let message { Text(message).font(.caption).foregroundStyle(.red) }
            }
            .card(padding: 10)
            .onChange(of: model.target) { open = false }
        }
    }
}

/// "Is this wrong?": a note, sent with the answer on screen. The server takes
/// reports only from an account with an email, so without one it asks for one.
struct ReportForm: View {
    @Bindable var model: AppModel
    @FocusState private var focused: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if model.anonymous { needsEmail } else { form }
    }

    private var needsEmail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Add an email to report a wrong answer, so we can reply to you."))
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(L("Cancel")) { model.cancelReport() }.controlSize(.small)
                Button(L("Add an email…")) {
                    model.cancelReport()
                    model.settingsPane = .account
                    openWindow(id: "settings")
                    NSApp.activate()
                }
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
            }
        }
        .card(padding: 10)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("What was wrong?")).font(.callout.weight(.semibold))
            TextField(L("The D2 never came, the walk is longer…"), text: $model.reportNote, axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { model.sendReport() }
            Text(L("Sends the answer above and your note, with your email so you can get a reply."))
                .font(.caption).foregroundStyle(.secondary)
            if let r = model.reportResult { Text(r).font(.caption).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button(L("Cancel")) { model.cancelReport() }.controlSize(.small)
                Button(L("Send")) { model.sendReport() }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.reportSending || model.reportNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .card(padding: 10)
        .onAppear { focused = true }
    }
}
