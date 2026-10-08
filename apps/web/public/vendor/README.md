Third-party code, copied from npm by `scripts/vendor-preact.sh`,
`scripts/vendor-map.sh` and `scripts/vendor-mediabunny.sh`; never edited
by hand.

Each script pins its versions with their npm integrity (sha512) and
checks the tarball against it before unpacking. `SHA256SUMS` lists the
SHA-256 of every file here but this README; the scripts rewrite their
entries, and `apps/api/test/vendor.test.js` fails when a file doesn't
match it, is missing, or isn't listed.

- `preact-10.29.8/`: Preact and its hooks (MIT, LICENSE-preact) and htm
  (Apache-2.0, LICENSE-htm). The hooks' import of "preact" points at the
  file next to it; the folder has no "@" in its name, so module imports
  aren't redirected.

- `maplibre-gl@6.11.2/`: MapLibre GL JS, BSD-3-Clause (LICENSE.txt).
- `pmtiles@4.5.0/`: the PMTiles reader by Protomaps, BSD-3-Clause
  (https://github.com/protomaps/PMTiles). Its self-contained build, with
  one line added at the end to export it as a module. The npm package has
  no licence file, so LICENSE comes from the repository at the commit 4.5.0
  was published from (3b10e67).
- `mediabunny@1.61.3/`: Mediabunny by Vanilagy, MPL-2.0 (LICENSE), the
  video encoder of the timelapse page (admin/timelapse/). Its minified
  browser build, one self-contained module, unchanged; the source is at
  https://github.com/Vanilagy/mediabunny.
