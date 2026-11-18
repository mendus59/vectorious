# Bundled fonts

These fonts power the Text to vector tab. They come from the [Google Fonts repository](https://github.com/google/fonts) and are redistributed under their own licenses, which are in `licenses/`.

Each file is the unmodified font from that repository, losslessly repackaged as WOFF (same outlines, names and tables, zlib-compressed) with fontTools, which the opentype.js reader in the browser can load. They are only downloaded when the Text to vector tab uses them.

| Family | Files | License |
| --- | --- | --- |
| Lato | Lato-Regular.woff, Lato-Bold.woff | [OFL 1.1](licenses/lato-OFL.txt) |
| Bebas Neue | BebasNeue-Regular.woff | [OFL 1.1](licenses/bebasneue-OFL.txt) |
| Anton | Anton-Regular.woff | [OFL 1.1](licenses/anton-OFL.txt) |
| DM Serif Display | DMSerifDisplay-Regular.woff | [OFL 1.1](licenses/dmserifdisplay-OFL.txt) |
| Abril Fatface | AbrilFatface-Regular.woff | [OFL 1.1](licenses/abrilfatface-OFL.txt) |
| Arvo | Arvo-Regular.woff | [OFL 1.1](licenses/arvo-OFL.txt) |
| Pacifico | Pacifico-Regular.woff | [OFL 1.1](licenses/pacifico-OFL.txt) |
| Lobster | Lobster-Regular.woff | [OFL 1.1](licenses/lobster-OFL.txt) |
| Great Vibes | GreatVibes-Regular.woff | [OFL 1.1](licenses/greatvibes-OFL.txt) |
| Patrick Hand | PatrickHand-Regular.woff | [OFL 1.1](licenses/patrickhand-OFL.txt) |
| Indie Flower | IndieFlower-Regular.woff | [OFL 1.1](licenses/indieflower-OFL.txt) |
| Gochi Hand | GochiHand-Regular.woff | [OFL 1.1](licenses/gochihand-OFL.txt) |
| Schoolbell | Schoolbell-Regular.woff | [Apache 2.0](licenses/schoolbell-LICENSE.txt) |
| Short Stack | ShortStack-Regular.woff | [OFL 1.1](licenses/shortstack-OFL.txt) |
| Mouse Memoirs | MouseMemoirs-Regular.woff | [OFL 1.1](licenses/mousememoirs-OFL.txt) |
| Sniglet | Sniglet-Regular.woff | [OFL 1.1](licenses/sniglet-OFL.txt) |
| Luckiest Guy | LuckiestGuy-Regular.woff | [Apache 2.0](licenses/luckiestguy-LICENSE.txt) |
| Bangers | Bangers-Regular.woff | [OFL 1.1](licenses/bangers-OFL.txt) |
| Henny Penny | HennyPenny-Regular.woff | [OFL 1.1](licenses/hennypenny-OFL.txt) |
| Mystery Quest | MysteryQuest-Regular.woff | [OFL 1.1](licenses/mysteryquest-OFL.txt) |
| Press Start 2P | PressStart2P-Regular.woff | [OFL 1.1](licenses/pressstart2p-OFL.txt) |
| Silkscreen | Silkscreen-Regular.woff | [OFL 1.1](licenses/silkscreen-OFL.txt) |
| VT323 | VT323-Regular.woff | [OFL 1.1](licenses/vt323-OFL.txt) |
| Space Mono | SpaceMono-Regular.woff | [OFL 1.1](licenses/spacemono-OFL.txt) |
| UnifrakturMaguntia | UnifrakturMaguntia-Book.woff | [OFL 1.1](licenses/unifrakturmaguntia-OFL.txt) |

To add a font: convert it to WOFF the same way (`TTFont(path).flavor = 'woff'`), add the `.woff` and its license here, and list it in `FONT_GROUPS` in `js/app.js`.
