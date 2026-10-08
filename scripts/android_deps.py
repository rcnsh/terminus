#!/usr/bin/env python3
"""Checks the hashes gradle/verification-metadata.xml gained against the
repositories' own checksums, and adds the aapt2 jars for the other systems.
Run by scripts/android-deps.sh once Gradle has written the file again.

    python3 -I scripts/android_deps.py <metadata before> <metadata after>

Gradle writes the SHA-256 of whatever it downloaded. Each new file is
downloaded again from the repository that serves its group (the same split
as settings.gradle.kts), and must have the same SHA-256 and match the SHA-1
the repository publishes beside it. A hash that changed for a version
already listed means the published bytes changed: that stops it, for a
person to look at.

aapt2 comes as one jar per system, and Gradle records only this machine's.
CI runs on Linux, so every aapt2 version gets its -linux, -osx and -windows
jars, from Google Maven, checked against its SHA-1.

Exits 1 with the reasons when a check fails; the file is left unchanged.
"""

import hashlib
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

NS = "{https://schema.gradle.org/dependency-verification}"
GOOGLE = "https://dl.google.com/dl/android/maven2"
CENTRAL = "https://repo.maven.apache.org/maven2"
AAPT2_SYSTEMS = ("linux", "osx", "windows")
CHECKED = "checked against its published sha1"


def repositories(group):
    """Where settings.gradle.kts asks for a group, in its order."""
    if re.match(r"androidx\.|com\.android(\.|$)", group):
        return [GOOGLE]
    if group.startswith("com.google."):
        return [GOOGLE, CENTRAL]
    return [CENTRAL]


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def entries(path):
    """(group, name, version, file) -> every SHA-256 trusted for it."""
    out = {}
    for component in ET.parse(path).getroot().iter(NS + "component"):
        key = (component.get("group"), component.get("name"), component.get("version"))
        for artifact in component.iter(NS + "artifact"):
            trusted = set()
            for sha in artifact.iter(NS + "sha256"):
                trusted.add(sha.get("value"))
                trusted.update(t.get("value") for t in sha.iter(NS + "also-trust"))
            out[key + (artifact.get("name"),)] = trusted
    return out


def download(group, name, version, file):
    """The file and the repository it came from, its SHA-1 checked; or a
    reason it couldn't be."""
    path = f"{group.replace('.', '/')}/{name}/{version}/{file}"
    for base in repositories(group):
        data = fetch(f"{base}/{path}")
        if data is None:
            continue
        published = fetch(f"{base}/{path}.sha1")
        if published is None:
            return None, base, f"{file}: {base} publishes no .sha1 beside it"
        if published.decode().split()[0].lower() != hashlib.sha1(data).hexdigest():
            return None, base, f"{file}: doesn't match the .sha1 {base} publishes"
        return data, base, None
    return None, None, f"{file}: not found on {', '.join(repositories(group))}"


def add_artifact(text, group, name, version, file, sha256, origin):
    """Adds an artifact to its component, keeping Gradle's order by name."""
    head = f'<component group="{group}" name="{name}" version="{version}">'
    match = re.search(re.escape(head) + r"(.*?)\n      </component>", text, re.S)
    blocks = re.findall(r"\n         <artifact .*?</artifact>", match.group(1), re.S)
    blocks.append(
        f'\n         <artifact name="{file}">'
        f'\n            <sha256 value="{sha256}" origin="{origin}"/>'
        f"\n         </artifact>"
    )
    blocks.sort(key=lambda b: re.search(r'name="([^"]+)"', b).group(1))
    return text[: match.start(1)] + "".join(blocks) + text[match.end(1) :]


def main(before_path, after_path):
    before, after = entries(before_path), entries(after_path)
    problems = []

    changed = [k for k in after if k in before and after[k] != before[k]]
    for group, name, version, file in changed:
        problems.append(
            f"{group}:{name}:{version} {file}: its hash changed from the one already "
            "listed, so the published file isn't the one verified before"
        )

    new = [k for k in after if k not in before]
    for group, name, version, file in new:
        data, _, problem = download(group, name, version, file)
        if problem:
            problems.append(f"{group}:{name}:{version} {problem}")
        elif hashlib.sha256(data).hexdigest() not in after[(group, name, version, file)]:
            problems.append(f"{group}:{name}:{version} {file}: Gradle's hash isn't the repository's")

    text = open(after_path, encoding="utf-8").read()
    added = []
    for group, name, version in sorted({k[:3] for k in after}):
        if (group, name) != ("com.android.tools.build", "aapt2"):
            continue
        for system in AAPT2_SYSTEMS:
            file = f"aapt2-{version}-{system}.jar"
            if (group, name, version, file) in after:
                continue
            data, _, problem = download(group, name, version, file)
            if problem:
                problems.append(f"{group}:{name}:{version} {problem}")
                continue
            sha256 = hashlib.sha256(data).hexdigest()
            text = add_artifact(text, group, name, version, file, sha256, f"Google Maven, {CHECKED}")
            added.append(file)

    if problems:
        print("Dependency hashes that didn't check out:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        sys.exit(1)

    if added:
        with open(after_path, "w", encoding="utf-8") as f:
            f.write(text)
    print(f"{len(new)} new files match their repository's checksums.")
    for file in added:
        print(f"Added {file} from Google Maven.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
