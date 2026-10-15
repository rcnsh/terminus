# Campus posters

A3 posters for noticeboards around campus. Each has a PDF to print, a PNG
(2380 × 3368) for screens, and the HTML it's drawn from:

| Poster | Headline |
| --- | --- |
| `never-run` | Never run for a bus again. |
| `ticket` | Your ticket to being on time. |
| `board` | Your own departure board. |

The HTML is drawn at 1190 × 1684 CSS pixels with the website's own fonts
(from `apps/web/public/assets/fonts`) and the shuttles' livery colours.
`qr.svg` (dark) and `qr-white.svg` (for the dark board poster) open
https://terminus.run. The board's LED rows use Menlo, so export it on a Mac.

To change one, edit its HTML and open it in Chrome to check, then:

- **PDF:** Print, Save as PDF, paper size A3, margins None, background
  graphics on, scale to fit the page.
- **PNG:** in DevTools, set the device to 1190 × 1684 at a pixel ratio
  of 2, then Capture screenshot.

Scan the QR code with a phone before printing.
