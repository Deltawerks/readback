# Bundled fonts

These are unmodified **latin-subset variable** builds of two open-source fonts,
served locally by the panel so it makes **no outbound network requests** and
renders identically offline.

| File | Font | Designer | License |
|---|---|---|---|
| `orbitron-latin.woff2` | [Orbitron](https://fonts.google.com/specimen/Orbitron) | Matt McInerney | [SIL Open Font License 1.1](https://openfontlicense.org/) |
| `roboto-latin.woff2` | [Roboto](https://fonts.google.com/specimen/Roboto) | Christian Robertson | [SIL Open Font License 1.1](https://openfontlicense.org/) |

Both are redistributable under the OFL, including bundled inside another
project. They are not modified — only the latin subset is shipped (the full
files also carry cyrillic/greek/vietnamese/math ranges Readback's UI never uses).

Retrieved from the Google Fonts CDN. To refresh them, re-download the latin
`woff2` for each family and drop the files in here — the `@font-face` rules live
at the top of `panel/index.html`.
