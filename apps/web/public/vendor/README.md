Third-party code, copied from npm by `scripts/vendor-preact.sh`,
`scripts/vendor-map.sh` and `scripts/vendor-mediabunny.sh`; never edited
by hand.

- `preact-10.29.8/`: Preact and its hooks (MIT, LICENSE-preact) and htm
  (Apache-2.0, LICENSE-htm). The hooks' import of "preact" points at the
  file next to it; the folder has no "@" in its name, so module imports
  aren't redirected.

- `maplibre-gl@6.11.2/`: MapLibre GL JS, BSD-3-Clause (LICENSE.txt).
- `pmtiles@4.5.0/`: the PMTiles reader by Protomaps, BSD-3-Clause
  (https://github.com/protomaps/PMTiles). Its self-contained build, with
  one line added at the end to export it as a module.
- `mediabunny@1.61.3/`: Mediabunny by Vanilagy, MPL-2.0 (LICENSE), the
  video encoder of the timelapse page (admin/timelapse/). Its minified
  browser build, one self-contained module, unchanged; the source is at
  https://github.com/Vanilagy/mediabunny.
