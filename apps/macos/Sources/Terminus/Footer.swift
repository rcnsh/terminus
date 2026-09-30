import SwiftUI
import os
import AppKit

// MARK: - Footer

struct Footer: View {
    @Bindable var model: AppModel
    @Environment(\.openWindow) private var openWindow

    /// A menu bar app's window comes up behind whatever is in front unless the app activates.
    private func open(_ id: String) {
        openWindow(id: id)
        NSApp.activate()
    }

    var body: some View {
        HStack {
            if model.paired && model.isSnapshot {
                Label("Settings", systemImage: "gearshape")
            } else if model.paired {
                Menu {
                    Toggle(model.misplaced ? "Open at login (move to Applications first)" : "Open at login", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
                        .disabled(model.misplaced && !model.openAtLogin)
                    Toggle("Notify me when to leave for class", isOn: Binding(get: { model.leaveAlerts }, set: { model.setLeaveAlerts($0) }))
                    Button("Set up…") { open("setup") }
                    Button("Devices…") { open("devices") }
                    Button("Refresh now") { Task { await model.refresh() } }
                    Button("Report a wrong answer…") { model.startReport() }
                    Button(Updater.shared.running ? "Check for updates…" : "Check for updates (move to Applications first)") {
                        Updater.shared.checkNow()
                    }
                    .disabled(!Updater.shared.running)
                    Divider()
                    Button("Sign out of this Mac") { model.unpair() }
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
