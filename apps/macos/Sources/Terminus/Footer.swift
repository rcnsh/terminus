import AppKit
import SwiftUI

struct Footer: View {
    @Bindable var model: AppModel
    @Environment(\.openWindow) private var openWindow

    private func open(_ id: String) {
        openWindow(id: id)
        NSApp.activate()
    }

    var body: some View {
        HStack {
            if model.paired && model.isSnapshot {
                Label(L("Settings"), systemImage: "gearshape")
                Label(L("Map"), systemImage: "map").padding(.leading, 12)
            } else if model.paired {
                Menu {
                    Button(L("Map…")) { open("map") }
                    Button(L("Settings…")) { open("settings") }
                    Button(L("Refresh now")) { Task { await model.refresh() } }
                    Button(L("Report a wrong answer…")) { model.startReport() }
                    Divider()
                    Button(L("Sign out of this Mac")) { model.unpair() }
                } label: {
                    Label(L("Settings"), systemImage: "gearshape")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                Button {
                    open("map")
                } label: {
                    Label(L("Map"), systemImage: "map")
                }
                .buttonStyle(.plain)
                .keyboardShortcut("m")
                .padding(.leading, 12)
                .background {
                    Button("") { open("settings") }
                        .keyboardShortcut(",")
                        .opacity(0)
                        .focusable(false)
                        .accessibilityHidden(true)
                }
            }
            Spacer()
            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Label(L("Quit"), systemImage: "power")
            }
            .buttonStyle(.plain)
            .keyboardShortcut("q")
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.primary.opacity(0.04))
        .overlay(alignment: .top) { Divider() }
    }
}
