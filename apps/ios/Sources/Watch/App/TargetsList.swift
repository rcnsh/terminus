import SwiftUI

/// What Now shows, chosen from a list in the phone's order: Next, Nearby,
/// then your favourites. Sign out at the foot, the watch's only setting:
/// it signs out this watch alone.
struct TargetsList: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false

    var body: some View {
        List {
            Section {
                row(.plan)
                row(.nearby)
                ForEach(model.places, id: \.key) { p in row(.place(key: p.key, label: p.label)) }
            }
            Section {
                Button(L("Sign out"), role: .destructive) { confirmSignOut = true }
                    .accessibilityIdentifier("signOut")
            } footer: {
                Text(L("Signs out this watch only.")).font(.footnote)
            }
        }
        .confirmationDialog(L("Sign out of this watch?"), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(L("Sign out"), role: .destructive) {
                model.signOut()
                dismiss()
            }
            Button(L("Cancel"), role: .cancel) {}
        }
    }

    private func row(_ v: WatchModel.View) -> some View {
        Button {
            model.choose(v)
            dismiss()
        } label: {
            HStack {
                Text(v.label).lineLimit(2)
                Spacer(minLength: 4)
                if model.view == v { Image(systemName: "checkmark").foregroundStyle(Color.brand) }
            }
        }
        .accessibilityAddTraits(model.view == v ? .isSelected : [])
        .accessibilityIdentifier("target.\(v.label)")
    }
}
