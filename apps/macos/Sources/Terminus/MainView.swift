import SwiftUI
import os
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
                    Text("terminus \(v) is out").font(.callout)
                    Spacer()
                    // Sparkle usually gets there first; this is for when it hasn't
                    // yet, or can't (a copy outside Applications).
                    if Updater.shared.running {
                        Button("Update") { Updater.shared.checkNow() }.controlSize(.small)
                    } else {
                        Button("Download") { NSWorkspace.shared.open(URL(string: "https://terminus.rcn.sh/download/mac")!) }.controlSize(.small)
                    }
                }
                .card(padding: 10)
            }

            if model.wantsSetup {
                HStack(spacing: 10) {
                    Image(systemName: "house.fill").foregroundStyle(Color.brand).accessibilityHidden(true)
                    Text("Add where you live and your timetable").font(.callout)
                    Spacer()
                    Button("Set up") {
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
                    Text("Start from the stop you're nearest").font(.callout)
                    Spacer()
                    Button("Allow") { model.askLocation() }.controlSize(.small)
                }
                .card(padding: 10)
            } else if model.locationDenied {
                // Updating from an ad-hoc build (1.3.7 or earlier, or a local
                // one) can lose the permission; say so instead of quietly guessing.
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
                    AnswerDetail(answer: answer, busy: model.signalling, onAction: model.signal, onChoice: model.choose).transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .top)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.showNearby)
            .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.target)

            // Today, on the plan's tab: the rest of the day under the next trip.
            if !model.showNearby, model.target == .plan, let day = model.day, !day.items.isEmpty || model.removed != nil {
                TodayList(day: day, removed: model.removed, onRemove: model.removeFromToday, onUndo: model.undoRemove).padding(.horizontal, 4)
            }

            if model.reporting {
                ReportForm(model: model)
            } else if let result = model.reportResult {
                Text(result).font(.callout).foregroundStyle(.secondary)
            }

            Search(model: model, query: $query)
        }
    }
}

/// "Is this wrong?": a note, sent with the answer on screen.
struct ReportForm: View {
    @Bindable var model: AppModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What was wrong?").font(.callout.weight(.semibold))
            TextField("The D2 never came, the walk is longer…", text: $model.reportNote, axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { model.sendReport() }
            Text("Sends the answer above and your note, with your email so you can get a reply.")
                .font(.caption).foregroundStyle(.secondary)
            if let r = model.reportResult { Text(r).font(.caption).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { model.cancelReport() }.controlSize(.small)
                Button("Send") { model.sendReport() }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.reportSending)
            }
        }
        .card(padding: 10)
        .onAppear { focused = true }
    }
}
