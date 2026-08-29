# web/fonts — the C26 era-skin bitmap fonts

Shipped as repolvable files (the runtime stays dependency-free: no font
CDN, `@font-face` in sm-view.css points here). Provenance and licenses:

## ms_sans_serif.woff2 / ms_sans_serif_bold.woff2

The "Pixelated MS Sans Serif" face — a pixel-exact vectorization of the
classic MS Sans Serif bitmap. Chrome font of the era skin: title-bar
caption, panel titles, buttons, labels — 11px, integer sizes only.
Taken from [98.css](https://github.com/jdan/98.css) (dist
`ms_sans_serif*.woff2`, unchanged), which ships it under the MIT
license.

## px437-ibm-vga9.woff

The int10h Ultimate Oldschool PC Font Pack's IBM VGA 8x16 text-mode face
(pack name Px437/Web437 IBM VGA 8x16, "IBM VGA9"). Bitmap mono of the
era skin: the program listing, bitfields, FIFO words, waveform
annotations — 16px, integer sizes only (its native cell; pixel-exact
there, never scaled). Taken from
[int10h.org](https://int10h.org/oldschool-pc-fonts/) pack v2.2, file
`woff - Web (webfonts)/Web437_IBM_VGA_8x16.woff`, unchanged; the pack is
licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Rejected candidate (documented per the C26 card)

Cozette — its browser-shippable forms are the Vector outline woff2
(antialiases: not era-crisp) or bitmap .otb/.bdf (not loaded by any
browser engine). Px437 IBM VGA9 won the mockup round.
