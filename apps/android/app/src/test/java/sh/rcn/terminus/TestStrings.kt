package sh.rcn.terminus

import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

/**
 * strings.xml for unit tests, which have no Context: [L] reads from here.
 * `install("values-zh")` for the Chinese.
 */
object TestStrings {
    fun read(dir: String): Map<String, String> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/res/$dir/strings.xml"))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val n = nodes.item(i)
            val raw = n.textContent
            // A quoted string keeps its edge spaces; the quotes aren't part of it.
            val text = if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw.substring(1, raw.length - 1) else raw
            n.attributes.getNamedItem("name").nodeValue to unescape(text)
        }
    }

    private fun unescape(s: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                out.append(if (s[i + 1] == 'n') '\n' else s[i + 1])
                i += 2
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    fun install(dir: String = "values") {
        val text = read(dir)
        val names = R.string::class.java.fields.associate { it.getInt(null) to it.name }
        L.use { id, args ->
            val raw = text[names[id]] ?: error("no string ${names[id]} in $dir")
            if (args.isEmpty()) raw else String.format(Locale.ROOT, raw, *args)
        }
    }
}
