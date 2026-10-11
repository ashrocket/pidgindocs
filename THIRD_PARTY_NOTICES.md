# Third-party notices

The project [MIT license](LICENSE) covers the original PidginDocs source and the finished bird image included here. The packages and font below keep their own licenses. `server/package-lock.json` pins exact npm versions; npm installs their code and license files separately. This source repository does not vendor `node_modules` or a generated Worker bundle.

## Bundled source and font

- The adapted Jevbox files in `server/legacy/jevbox/` retain their upstream MIT copyright and license in [LICENSE-jevbox.md](server/legacy/jevbox/LICENSE-jevbox.md).
- `server/fonts/Inter-Bold.woff` and `Inter-SemiBold.woff` retain the SIL Open Font License 1.1 and copyright in [OFL.txt](server/fonts/OFL.txt).

## Runtime npm packages

| Package | Locked version | License |
| --- | ---: | --- |
| [`@resvg/resvg-wasm`](https://github.com/yisibl/resvg-js/tree/v2.6.2) | 2.6.2 | MPL-2.0 |
| [`satori`](https://github.com/vercel/satori) | 0.26.0 | MPL-2.0 |
| [`jose`](https://github.com/panva/jose/tree/v6.2.12) | 6.2.12 | MIT |
| [`marked`](https://github.com/markedjs/marked/tree/v18.0.5) | 18.0.5 | MIT |

The transitive runtime packages are `@shuding/opentype.js`, `fflate`, `string.prototype.codepointat`, `css-background-parser`, `css-box-shadow`, `css-gradient-parser`, `css-to-react-native`, `camelize`, `postcss-value-parser`, `emoji-regex-xs`, `escape-html`, `linebreak`, `base64-js`, `unicode-trie`, `pako`, `tiny-inflate`, `parse-css-color`, `color-name`, `hex-rgb`, and `yoga-layout` (MIT), plus `css-color-keywords` (ISC). Their exact versions, registry locations, and integrity hashes are in the lockfile. Preserve their package copyright and license files when redistributing their code.

The two MPL packages are file-level copyleft components. A copy of the [MPL 2.0 text](third_party/MPL-2.0.txt) is included for convenience. If you redistribute a built Worker containing their code, retain the package notices and make the source of covered package files, including your changes to those files, available as the MPL requires. This repository's project MIT license does not replace those terms.

The development and test toolchain is also pinned in `server/package-lock.json` but is not imported by the application at runtime. It includes MPL-2.0 Lightning CSS and optional platform-specific LGPL-3.0-or-later sharp/libvips packages. Their notices and source obligations matter if those components are included in an artifact you redistribute. Check the contents of the actual artifact rather than assuming every optional lockfile entry is present.
