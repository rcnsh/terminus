#!/usr/bin/env python3
"""The Sparkle appcast for one Mac release: one item, the new version.

    scripts/appcast.py <version> <build> <min-os> <ed-signature> <dmg> <site>

Sparkle compares <build> (CFBundleVersion). The DMG is named by its path
under <site>/download/, as /download/releases/<version>/ serves it. A
release's item links to its tag's page on GitHub: scripts/release.sh pushes
the tag before it uploads this, so the link never leads nowhere.
"""
import email.utils, os, sys
from xml.sax.saxutils import escape, quoteattr

version, build, min_os, sig, dmg, site = sys.argv[1:]
url = f'{site}/download/releases/{version}/terminus-{version}.dmg'
title = 'terminus beta' if 'beta.' in site else 'terminus'
notes = f'https://github.com/rcnsh/terminus/releases/tag/v{version}' if title == 'terminus' else site
# Every value escaped, attributes quoted: none of these should ever hold
# '<' or '&', but an appcast that breaks would stop every Mac updating.
title_x, site_x, notes_x = escape(title), escape(site), escape(notes)
version_x, build_x, min_os_x = escape(version), escape(build), escape(min_os)
print(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>{title_x}</title>
    <link>{site_x}</link>
    <item>
      <title>{title_x} {version_x}</title>
      <pubDate>{email.utils.formatdate(usegmt=True)}</pubDate>
      <link>{notes_x}</link>
      <sparkle:version>{build_x}</sparkle:version>
      <sparkle:shortVersionString>{version_x}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{min_os_x}</sparkle:minimumSystemVersion>
      <enclosure url={quoteattr(url)} type="application/octet-stream" sparkle:edSignature={quoteattr(sig)} length="{os.path.getsize(dmg)}"/>
    </item>
  </channel>
</rss>''')
