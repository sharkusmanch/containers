# Third-party notices

## Inkharbor

Parts of the guide reader are adapted from [Inkharbor](https://github.com/tahsinrefat22/inkharbor) (an Outline client, MIT).
Source commit: `727246326625f25197ce5e0a9ba1f4f3fd318d5b`.

| Inkharbor file                  | Adapted into                                         |
| ------------------------------- | ---------------------------------------------------- |
| `src/lib/editor/render-html.ts` | `src/web/guide-render.ts`                            |
| `src/lib/outline/edits.ts`      | `src/web/guide-checkbox.ts`, `src/web/guide-tick.ts` |

Intentional differences from the originals:

- Checkbox matching stays inside one Markdown block: the patch widens only across non-blank lines,
  and refuses when no such window is unique (Inkharbor widens across blank lines).
- URL allow-list: links and cards open only `http(s)` addresses, in-app links only `/doc/<id>`, and
  images only attachment redirects; any other scheme is shown as text.
- Notices are styled by class (`notice-info`, `notice-warning`, ...), not by an inline `style`
  attribute, because the page's CSP forbids inline styles.
- No maths rendering and no emoji table: maths shows its TeX in `<code>`, and only the emoji the
  guides use are mapped.
- No module-level state: image URLs, checkbox numbering and heading ids are per call.

### Licence

MIT License

Copyright (c) 2026 Tahsin Ahmed Refat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
