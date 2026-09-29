import SwiftUI
import os
import AppKit

// MARK: - Main

struct Main: View {
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
