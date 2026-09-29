import SwiftUI
import os

// MARK: - Pairing

struct Pair: View {
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
