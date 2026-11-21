import SwiftUI

struct DayTimeline: View {
    let day: DayPlan
    var top: CGFloat = 20
    @Environment(AppModel.self) private var app

    var body: some View {
        let removed = app.removed
        if !day.items.isEmpty || removed != nil {
            let noteAt: Int? = removed.map { n in
                n.before.flatMap { b in day.items.firstIndex { $0.key == b } } ?? min(n.at, day.items.count)
            }
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel(L("Today")).padding(.bottom, 6)
                ForEach(Array(day.items.enumerated()), id: \.element.key) { i, item in
                    if i == noteAt, let removed { RemovedRow(note: removed) }
                    if item.removable {
                        SwipeAway(onRemove: { app.removeFromToday(item) }) {
                            DayRow(item: item) {
                                Button {
                                    app.removeFromToday(item)
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Color.muted)
                                        .frame(width: 44, height: 44)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(L("Remove %@ from today", shortName(item)))
                                .accessibilityIdentifier("remove.\(item.key)")
                            }
                        }
                        .accessibilityAction(named: L("Remove %@ from today", shortName(item))) { app.removeFromToday(item) }
                    } else {
                        DayRow(item: item) { EmptyView() }
                    }
                }
                if noteAt == day.items.count, let removed { RemovedRow(note: removed) }
            }
            .padding(.top, top)
            .animation(.snappy, value: day.items.map(\.key))
        }
    }
}

func shortName(_ item: DayPlan.Item) -> String {
    item.kind == "home" ? L("The trip home") : (item.label.components(separatedBy: " @ ").first ?? item.label)
}

private struct DayRow<End: View>: View {
    let item: DayPlan.Item
    @ViewBuilder var end: End
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 72

    var body: some View {
        let past = item.status == "done" || item.status == "skipped"
        let current = item.status == "next" || item.status == "now"
        HStack(alignment: .center, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text(item.starts.map(campusTime) ?? "")
                    .font(.subheadline.weight(current ? .semibold : .regular))
                    .foregroundStyle(past ? Color.muted : Color.ink)
                    .frame(minWidth: timeWidth, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .fontWeight(current ? .semibold : .regular)
                        .foregroundStyle(past ? Color.muted : Color.ink)
                        .strikethrough(item.status == "skipped")
                    if let sub = subline { Text(sub).font(.footnote).foregroundStyle(Color.muted) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
            end
        }
        .frame(minHeight: 48)
    }

    private var subline: String? { item.status == "done" ? nil : item.line }
}

private struct RemovedRow: View {
    let note: AppModel.Removed
    @Environment(AppModel.self) private var app
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 72

    var body: some View {
        let text = note.failed ? L("Couldn't remove it. Check your connection.") : L("%@ removed from today", shortName(note.item))
        HStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text(note.item.starts.map(campusTime) ?? "").font(.subheadline).foregroundStyle(Color.muted).frame(
                    minWidth: timeWidth, alignment: .leading)
                Text(text).foregroundStyle(note.failed ? Color.bad : Color.muted).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            if !note.failed {
                Button(L("Undo")) { app.undoRemove() }
                    .font(.body.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.leading, 8)
                    .accessibilityIdentifier("undo")
            }
        }
        .frame(minHeight: 48)
        .announced(text)
        .task(id: note.item.key) {
            guard (try? await Task.sleep(for: .seconds(20))) != nil else { return }
            app.dismissRemoved(note.item.key)
        }
        .transition(.opacity)
    }
}

private struct SwipeAway<Content: View>: View {
    let onRemove: () -> Void
    @ViewBuilder var content: Content
    @State private var dx: CGFloat = 0
    @State private var width: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var still
    private var reach: CGFloat { min(140, width * 0.4) }
    private var armed: Bool { abs(dx) > reach }

    var body: some View {
        content
            .padding(.leading, 8)
            .background(dx == 0 ? Color.page : Color.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .shadow(color: .black.opacity(dx == 0 ? 0 : 0.12), radius: 3, y: 1)
            .offset(x: dx)
            .background {
                if dx != 0 {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(armed ? Color.bad.opacity(0.18) : Color.surface2)
                        .overlay(alignment: dx > 0 ? .leading : .trailing) {
                            Image(systemName: "trash")
                                .foregroundStyle(armed ? Color.bad : Color.muted)
                                .scaleEffect(armed ? 1.15 : 1)
                                .padding(.horizontal, 20)
                        }
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, -8)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                width = $0
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 20)
                    .onChanged { v in
                        guard abs(v.translation.width) > abs(v.translation.height) else { return }
                        dx = v.translation.width
                    }
                    .onEnded { v in
                        guard dx != 0 else { return }
                        let speed = v.velocity.width
                        let heading = dx + Fling.project(speed)
                        let sideways =
                            abs(v.velocity.width) > abs(v.velocity.height) && abs(v.translation.width) > abs(v.translation.height)
                        if (armed || sideways) && abs(heading) > reach && (heading > 0) == (dx > 0) {
                            let out = dx > 0 ? width : -width
                            withAnimation(still ? nil : Fling.spring(speed: speed, from: dx, to: out)) {
                                dx = out
                            } completion: {
                                onRemove()
                            }
                        } else {
                            withAnimation(still ? nil : Fling.spring(speed: speed, from: dx, to: 0)) { dx = 0 }
                        }
                    }
            )
            .sensoryFeedback(.impact(weight: .light), trigger: armed)
    }
}
