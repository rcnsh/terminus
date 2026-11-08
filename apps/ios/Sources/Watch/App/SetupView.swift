import SwiftUI

/// A watch not signed in: where to set it up. The code comes from the
/// iPhone (Settings › Devices › Set up your watch); nothing is typed here.
struct SetupView: View {
    @Environment(WatchModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Wordmark(size: 20)
                if let reason = model.signedOutReason {
                    Text(reason).font(.footnote).foregroundStyle(Color.warn).accessibilityIdentifier("setup.reason")
                }
                Text(L("Open terminus on your iPhone to set up your watch"))
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("setup.title")
                Text(L("In Settings, Devices, tap Set up your watch."))
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if model.pairing {
                    HStack(spacing: 8) {
                        ProgressView().frame(width: 20, height: 20)
                        Text(L("Signing in…")).foregroundStyle(Color.muted)
                    }
                } else if let e = model.pairError {
                    Text(e).font(.footnote).foregroundStyle(Color.warn)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
        }
    }
}
