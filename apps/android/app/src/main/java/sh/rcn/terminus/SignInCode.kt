package sh.rcn.terminus

/** How long the code in a sign-in email is: six letters and digits (applogin.ts). */
const val CODE_LENGTH = 6

/** What a code is made of: no 0/O or 1/I/L to misread (accounts.ts PAIR_ALPHABET). */
private const val CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * What the code boxes hold after the field changed from [old] to [new]:
 * capitals, letters and digits only, at most [CODE_LENGTH], filling the
 * boxes from the left so each character typed moves on to the next box.
 *
 * A paste (more than one character arriving at once) may bring words with
 * it, or land after what was already typed: "Your code is 7KQ2XM", or
 * "AB7KQ2XM". Then the code is the last six-character word that could be
 * one (so not "WITHIN"), else its last six letters and digits ("7KQ 2XM"
 * and "7KQ-2XM" too).
 */
fun codeEdit(old: String, new: String): String {
    val up = new.uppercase()
    val chars = up.filter(::isCodeChar)
    if (chars.length - old.length <= 1) return chars.take(CODE_LENGTH)
    up.split(Regex("[^A-Z0-9]+")).lastOrNull { w -> w.length == CODE_LENGTH && w.all { it in CODE_ALPHABET } }?.let { return it }
    return chars.takeLast(CODE_LENGTH)
}

private fun isCodeChar(c: Char) = c in 'A'..'Z' || c in '0'..'9'
