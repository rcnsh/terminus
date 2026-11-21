package sh.rcn.terminus

const val CODE_LENGTH = 6

private const val CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

fun codeEdit(old: String, new: String): String {
    val up = new.uppercase()
    val chars = up.filter(::isCodeChar)
    if (chars.length - old.length <= 1) return chars.take(CODE_LENGTH)
    up.split(Regex("[^A-Z0-9]+"))
        .lastOrNull { w -> w.length == CODE_LENGTH && w.all { it in CODE_ALPHABET } }
        ?.let {
            return it
        }
    return chars.takeLast(CODE_LENGTH)
}

private fun isCodeChar(c: Char) = c in 'A'..'Z' || c in '0'..'9'
