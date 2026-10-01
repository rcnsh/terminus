#!/usr/bin/env python3
"""The Sparkle appcast for one Mac release: one item, the new version.

    scripts/appcast.py <version> <build> <min-os> <ed-signature> <dmg> <site>

Sparkle compares <build> (CFBundleVersion). The DMG is named by its path
under <site>/download/, as /download/releases/<version>/ serves it.
"""
import email.utils, os, sys
from xml.sax.saxutils import quoteattr

version, build, min_os, sig, dmg, site = sys.argv[1:]
url = f'{site}/download/releases/{version}/terminus-{version}.dmg'
title = 'terminus beta' if 'beta.' in site else 'terminus'
notes = f'https://github.com/rcnsh/terminus/releases/tag/v{version}' if title == 'terminus' else site
print(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>{title}</title>
    <link>{site}</link>
    <item>
      <title>{title} {version}</title>
      <pubDate>{email.utils.formatdate(usegmt=True)}</pubDate>
      <link>{notes}</link>
      <sparkle:version>{build}</sparkle:version>
      <sparkle:shortVersionString>{version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>{min_os}</sparkle:minimumSystemVersion>
      <enclosure url={quoteattr(url)} type="application/octet-stream" sparkle:edSignature={quoteattr(sig)} length="{os.path.getsize(dmg)}"/>
    </item>
  </channel>
</rss>''')
