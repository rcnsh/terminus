import Foundation
import Testing
@testable import Terminus

/// Chinese (phase 10): every string the app writes has a translation with the
/// same blanks, none is left in the views, and the server's Chinese answers
/// read like its English ones.
private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

private func chinese() throws -> [String: String] {
    let data = try Data(contentsOf: root.appendingPathComponent("Support/zh-Hans.lproj/Localizable.strings"))
    return try #require(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
}

private func sources() throws -> [(String, String)] {
    let dir = root.appendingPathComponent("Sources/Terminus")
    return try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".swift") && $0 != "Snapshots.swift" }.map {
        ($0, try String(contentsOf: dir.appendingPathComponent($0), encoding: .utf8))
    }
}

/// The string literals in `text` matched by `pattern`'s first group, unescaped.
private func literals(_ pattern: String, in text: String) throws -> [String] {
    let re = try NSRegularExpression(pattern: pattern)
    return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
        Range(m.range(at: 1), in: text).map { String(text[$0]).replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\") }
    }
}

@Test func everyStringTheAppWritesIsTranslated() throws {
    let zh = try chinese()
    var missing: [String] = []
    for (file, text) in try sources() {
        for key in try literals(#"\bL\("((?:\\.|[^"\\])*)""#, in: text) where zh[key] == nil {
            missing.append("\(file): \(key)")
        }
    }
    #expect(missing == [])
}

@Test func translationsHaveTheSameBlanks() throws {
    let blanks = try NSRegularExpression(pattern: #"%(?:\d\$)?@"#)
    let count = { (s: String) in blanks.numberOfMatches(in: s, range: NSRange(s.startIndex..., in: s)) }
    for (en, zh) in try chinese() {
        #expect(count(en) == count(zh), "\(en)")
        #expect(zh.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3000...0x303F).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) }, "\(en): \(zh)")
    }
}

/// A Text("Some words") in a view would be English in Chinese too.
@Test func noWordsAreLeftInTheViews() throws {
    let allowed: Set = ["terminus", "termi", "nus", "you@u.nus.edu", "ABC 123", "https://nusmods.com/timetable/sem-1/share?…"]
    var found: [String] = []
    for (file, text) in try sources() {
        for s in try literals(#"\b(?:Text|Button|Toggle|Label|Picker|TextField|Window|Stepper|Hint|help|accessibilityLabel)\("((?:\\.|[^"\\])*[A-Za-z]{2,}(?:\\.|[^"\\])*)""#, in: text)
        where !allowed.contains(s) && !s.hasPrefix("\\(") {
            found.append("\(file): \(s)")
        }
    }
    #expect(found == [])
}

/// The API's Chinese goldens (apps/api/test/fixtures/answers/zh) decode, with their card.
@Test(arguments: ["class-bus", "class-walk", "free", "rest", "home", "setup"])
func chineseAnswersDecode(name: String) throws {
    let url = root.appendingPathComponent("../api/test/fixtures/answers/zh/\(name).json").standardized
    let a = try JSONDecoder().decode(NextAnswer.self, from: Data(contentsOf: url))
    #expect(a.card != nil)
    #expect(a.label.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } || a.label.contains("分钟"))
}

@Test func chineseErrorsEndWithAFullWidthStop() {
    #expect(sentence("请先登录") == "请先登录。")
    #expect(sentence("not a valid link") == "Not a valid link.")
}
