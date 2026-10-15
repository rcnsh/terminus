import SwiftUI

/// Today at a glance, from /me/day: each class with its leave-by, and the
/// trips home. What's done is dimmed. Anything still to come has an × to
/// take it off today (a swipe does the same); it goes at once, and its row
/// says so with Undo for 20 seconds, as on Android and the web app.
struct DayTimeline: View {
    let day: DayPlan
    @Environment(AppModel.self) private var app

    var body: some View {
        let removed = app.removed
        if !day.items.isEmpty || removed != nil {
            // Above the entry that followed it, else where it was.
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
            .padding(.top, 20)
            .animation(.snappy, value: day.items.map(\.key))
        }
    }
}

/// What a removed entry is called in its row: the trip home, or the class without its venue.
func shortName(_ item: DayPlan.Item) -> String {
    item.kind == "home" ? L("The trip home") : (item.label.components(separatedBy: " @ ").first ?? item.label)
}

/// One entry of the day: its time, what it is, and how you get there (or that it's off).
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
            end
        }
        .frame(minHeight: 48)
        .accessibilityElement(children: .combine)
    }

    /// The server's line; worded here only for an older server.
    private var subline: String? {
        if item.status == "done" { return nil }
        if let line = item.line { return line }
        if item.status == "skipped" { return L("Not going") }
        if let b = item.onBus {
            return
                ([L("On the %@", b.svc)]
                + [b.off.map { L("off at %@", $0) }, b.arrive.flatMap(parseISODate).map { L("arrive %@", campusTime($0)) }].compactMap {
                    $0
                }).joined(separator: " · ")
        }
        guard let leave = item.leave, let at = parseISODate(leave.at) else { return nil }
        let time = leave.estimated == true ? L("~%@", campusTime(at)) : campusTime(at)
        var parts = [L("Leave by %@", time), leave.svc.map { L("%@ from %@", $0, leave.stop ?? item.fromName ?? "") } ?? L("walk")]
        if item.timing?.status == "late", let t = item.timing?.text { parts.append(t) }
        return parts.joined(separator: " · ")
    }
}

/// Where an entry was, just taken off: "GEA1000 removed from today · Undo",
/// or why it couldn't be (the entry is back, just below). Said aloud as it
/// appears, and gone after 20 seconds.
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
            try? await Task.sleep(for: .seconds(20))
            app.dismissRemoved(note.item.key)
        }
        .transition(.opacity)
    }
}

/// Swipe either way to take it off today, a shortcut for the ×. The row
/// lifts onto a card as it moves; behind it a bin, grey until it's far
/// enough to let go, then red.
private struct SwipeAway<Content: View>: View {
    let onRemove: () -> Void
    @ViewBuilder var content: Content
    @State private var dx: CGFloat = 0
    @State private var width: CGFloat = 1
    private var armed: Bool { abs(dx) > min(140, width * 0.4) }

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
                        // Sideways only, so the page still scrolls.
                        guard abs(v.translation.width) > abs(v.translation.height) else { return }
                        dx = v.translation.width
                    }
                    .onEnded { _ in
                        if armed {
                            withAnimation(.easeOut(duration: 0.2)) { dx = dx > 0 ? width : -width }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                onRemove()
                                dx = 0
                            }
                        } else {
                            withAnimation(.spring(duration: 0.3)) { dx = 0 }
                        }
                    }
            )
            .sensoryFeedback(.impact(weight: .light), trigger: armed)
    }
}
