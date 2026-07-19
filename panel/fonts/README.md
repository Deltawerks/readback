# Bundled fonts

The **latin-subset variable** builds of two open-source fonts, served locally by
the panel so the page loads nothing from the internet and renders identically
offline.

| File | Font | License |
|---|---|---|
| `orbitron-latin.woff2` | [Orbitron](https://fonts.google.com/specimen/Orbitron) — Matt McInerney | [SIL Open Font License 1.1](OFL.txt) |
| `roboto-latin.woff2` | [Roboto](https://fonts.google.com/specimen/Roboto) — Christian Robertson | [SIL Open Font License 1.1](OFL.txt) |

Both are redistributable under the OFL, including bundled inside another
project. The full license text and both copyright notices ship alongside them in
[`OFL.txt`](OFL.txt), as OFL 1.1 §2 requires.

These are the latin subsets as distributed by Google Fonts — the upstream files
also carry cyrillic, greek, vietnamese, math and symbol ranges that Readback's
UI never renders. Dropping those ranges makes these *Modified Versions* under
the OFL's definition, so they are noted as such here rather than passed off as
the originals.

To refresh them, re-download the latin `woff2` for each family and drop the
files in here — the `@font-face` rules live at the top of `panel/index.html`.
