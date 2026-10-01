import SwiftUI
import os

// MARK: - Tabs

struct Tabs: View {
    @Bindable var model: AppModel
    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
        // No scrolling unless the tabs genuinely don't fit. Icons and text,
        // then text only, then text with less room around it, then scroll:
        // the first that fits.
        ViewThatFits(in: .horizontal) {
            strip(icons: true)
            strip(icons: false)
            strip(icons: false, inset: 6)
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) { strip(icons: false, inset: 6) }
                    // A tab cut off at the edge fades out, so the row reads as more to scroll to.
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0.9), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
                    .onAppear { proxy.scrollTo(current, anchor: .center) }
                    .onChange(of: current) { _, tab in withAnimation { proxy.scrollTo(tab, anchor: .center) } }
            }
        }
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(.primary.opacity(0.08)))
    }

    private func strip(icons: Bool, inset: CGFloat = 10) -> some View {
        HStack(spacing: 2) {
            ForEach(tabs, id: \.0) { tab, title, icon in
                let on = tab == current
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85)) { choose(tab) }
                } label: {
                    Label(title, systemImage: icon)
                        .font(.system(size: 12, weight: on ? .semibold : .medium))
                        .labelStyle(TabLabelStyle(icons: icons))
                        .foregroundStyle(on ? .primary : .secondary)
                        .fixedSize()
                        .padding(.horizontal, inset)
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
                .accessibilityLabel(title)
                .accessibilityAddTraits(on ? .isSelected : [])
                .id(tab)
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

struct TabLabelStyle: LabelStyle {
    let icons: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            if icons { configuration.icon }
            configuration.title
        }
    }
}
