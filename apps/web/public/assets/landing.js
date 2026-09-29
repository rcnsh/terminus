// The current version next to the download buttons, from the release manifest.
fetch('/download/latest.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((l) => {
    if (l?.version) document.getElementById('version').textContent = ` Version ${l.version}.`;
  })
  .catch(() => {});
