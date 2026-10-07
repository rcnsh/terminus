import Foundation
import Testing
@testable import Terminus

/// The code boxes, as Android's SignInCodeTest: typing fills them one by one,
/// and a paste keeps only the code from the words around it.
private func type(_ s: String, from start: String = "") -> String {
    s.reduce(start) { code, c in codeEdit(old: code, new: code + String(c)) }
}

@Test func typingFillsTheBoxesOneByOne() {
    #expect(codeEdit(old: "", new: "7") == "7")
    #expect(codeEdit(old: "7", new: "7k") == "7K")
    #expect(type("7kq2xm") == "7KQ2XM")
    #expect(type("A", from: "7KQ2XM") == "7KQ2XM")
    #expect(codeEdit(old: "7KQ2XM", new: "7KQ2X") == "7KQ2X")
    #expect(type("-2", from: "7KQ") == "7KQ2")
}

@Test func aPastedCodeKeepsOnlyTheCodeFromAroundIt() {
    #expect(codeEdit(old: "", new: "Your terminus code: 7KQ2XM") == "7KQ2XM")
    #expect(codeEdit(old: "", new: "Your sign-in code is 7KQ2XM. It works for 15 minutes.") == "7KQ2XM")
    #expect(codeEdit(old: "", new: "Your code is 7KQ2XM within 15 minutes") == "7KQ2XM")
    #expect(codeEdit(old: "", new: "你的登录验证码是 7KQ2XM。") == "7KQ2XM")
    #expect(codeEdit(old: "", new: " 7kq2xm\n") == "7KQ2XM")
}

@Test func aCodePastedInPiecesOrOverWhatWasTypedStillFits() {
    #expect(codeEdit(old: "", new: "7KQ 2XM") == "7KQ2XM")
    #expect(codeEdit(old: "", new: "7KQ-2XM") == "7KQ2XM")
    #expect(codeEdit(old: "AB", new: "AB7KQ2XM") == "7KQ2XM")
    #expect(codeEdit(old: "ABCDEF", new: "ABCDEF7KQ2XM") == "7KQ2XM")
}

/// `acc`: a fix's accuracy plus a walk since it was taken; the server ignores one over 200 m.
@Test func aFixSaysHowFarOutItMayBe() throws {
    #expect(fixUncertaintyM(accuracy: 30, ageS: 0) == 30)
    #expect(fixUncertaintyM(accuracy: 30, ageS: 100) == 160)
    // The popover closed: a ten-minute-old fix is too far out to plan from.
    #expect(try #require(fixUncertaintyM(accuracy: 30, ageS: 600)) > 200)
    #expect(fixUncertaintyM(accuracy: -1, ageS: 0) == nil)
    let q = Api.coords(1.29, 103.78, 160.4)
    #expect(q.map(\.name) == ["lat", "lon", "acc"])
    #expect(q.last?.value == "160")
    #expect(Api.coords(nil, 103.78, 20).isEmpty)
}

/// Send is offered once the email looks like one; the server checks the rest.
@Test func anEmailIsOfferedACodeOnceItLooksLikeOne() {
    #expect(looksLikeEmail("you@u.nus.edu"))
    #expect(looksLikeEmail("  you@u.nus.edu "))
    #expect(!looksLikeEmail("you@u"))
    #expect(!looksLikeEmail("you u@nus.edu"))
    #expect(!looksLikeEmail("you@@nus.edu"))
    #expect(!looksLikeEmail("you@nus.e"))
}
