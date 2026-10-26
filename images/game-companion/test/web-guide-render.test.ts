import { describe, expect, it } from "vitest";
import { checkboxItems, type PMNode } from "../src/web/guide-checkbox.js";
import { renderGuide } from "../src/web/guide-render.js";

const ctx = { origin: "https://outline.example" };

const text = (value: string, marks?: PMNode["marks"]): PMNode =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };
const para = (...content: PMNode[]): PMNode => ({ type: "paragraph", content });
const doc = (...content: PMNode[]): PMNode => ({ type: "doc", content });
const render = (...content: PMNode[]): string => renderGuide(doc(...content), ctx);
const item = (label: string, checked: boolean, ...more: PMNode[]): PMNode => ({
  type: "checkbox_item",
  attrs: { checked },
  content: [para(text(label)), ...more],
});
const list = (...items: PMNode[]): PMNode => ({ type: "checkbox_list", content: items });
const link = (href: string, label = "go"): PMNode =>
  text(label, [{ type: "link", attrs: { href } }]);

describe("checkbox_item and checkbox_list", () => {
  it("renders a checklist with a labelled button per item", () => {
    expect(render(list(item("Potion", false), item("Ether", true)))).toBe(
      '<ul class="checklist">' +
        '<li class="cb-item"><button type="button" class="cb" role="checkbox" aria-checked="false" aria-label="Potion" data-cb="0"></button><div class="cb-body"><p>Potion</p></div></li>' +
        '<li class="cb-item checked"><button type="button" class="cb" role="checkbox" aria-checked="true" aria-label="Ether" data-cb="1"></button><div class="cb-body"><p>Ether</p></div></li>' +
        "</ul>",
    );
  });

  it("labels an item by its first child only, collapsed and cut to 80 characters", () => {
    const nested = list(item("Nested thing", false));
    const html = render(list(item("Potion", false, nested)));
    expect(html).toContain('aria-label="Potion" data-cb="0"');
    expect(html).toContain('aria-label="Nested thing" data-cb="1"');

    const long = render(list(item(`  ${"word ".repeat(40)}`, false), item("a   b\n c", false)));
    expect(long).toContain(`aria-label="${"word ".repeat(16).trim()}" `);
    expect(long).toContain('aria-label="a b c"');
    expect(/aria-label="([^"]*)"/.exec(long)?.[1]?.length).toBeLessThanOrEqual(80);
  });

  it("falls back to Checkbox when the item has no text, and escapes the label", () => {
    const empty: PMNode = { type: "checkbox_item", attrs: { checked: false }, content: [para()] };
    expect(render(list(empty))).toContain('aria-label="Checkbox"');
    expect(render(list(item('<b>"x"</b>', false)))).toContain(
      'aria-label="&#60;b&#62;&#34;x&#34;&#60;/b&#62;"',
    );
  });

  it("numbers data-cb in checkboxItems order on a nested checklist, restarting per render", () => {
    const tree = doc(
      list(
        item("a", false, list(item("a1", true), item("a2", false, list(item("a2x", false))))),
        item("b", false),
      ),
      {
        type: "table",
        content: [{ type: "tr", content: [{ type: "td", content: [list(item("c", false))] }] }],
      },
    );
    const expected = checkboxItems(tree).map((_, n) => String(n));
    const numbers = [...renderGuide(tree, ctx).matchAll(/data-cb="(\d+)"/g)].map((m) => m[1]);
    expect(numbers).toEqual(expected);
    expect(numbers).toEqual(["0", "1", "2", "3", "4", "5"]);

    const other = renderGuide(doc(list(item("only", false))), ctx);
    expect(other).toContain('data-cb="0"');
    expect(other).not.toContain('data-cb="1"');
  });
});

describe("heading", () => {
  it("slugs the text into an id and clamps the level", () => {
    expect(
      render({ type: "heading", attrs: { level: 2 }, content: [text("Area One: The  Start!")] }),
    ).toBe('<h2 id="h-area-one-the-start">Area One: The  Start!</h2>');
    expect(render({ type: "heading", attrs: { level: 9 }, content: [text("A")] })).toContain(
      "<h6 ",
    );
    expect(render({ type: "heading", attrs: { level: 0 }, content: [text("A")] })).toContain(
      "<h1 ",
    );
    expect(render({ type: "heading", content: [text("A")] })).toContain("<h1 ");
  });

  it("numbers repeated headings and falls back to section when the slug is empty", () => {
    const h = (t: string): PMNode => ({ type: "heading", attrs: { level: 2 }, content: [text(t)] });
    expect(render(h("Boss"), h("Boss"), h("Boss"))).toBe(
      '<h2 id="h-boss">Boss</h2><h2 id="h-boss-2">Boss</h2><h2 id="h-boss-3">Boss</h2>',
    );
    expect(render(h("???"), h("!!"))).toBe(
      '<h2 id="h-section">???</h2><h2 id="h-section-2">!!</h2>',
    );
    expect(render(h("A"), h("A"), h("A 2"))).toBe(
      '<h2 id="h-a">A</h2><h2 id="h-a-2">A</h2><h2 id="h-a-2-2">A 2</h2>',
    );
  });
});

describe("link mark", () => {
  const A = 'target="_blank" rel="noopener noreferrer"';

  it("makes a /doc path an in-app link", () => {
    expect(render(para(link("/doc/abc-123")))).toBe(
      `<p><a href="/doc/abc-123" data-doc="/doc/abc-123" ${A}>go</a></p>`,
    );
  });

  it("accepts the Outline origin form and drops the query and hash", () => {
    expect(render(para(link("https://outline.example/doc/abc?x=1#h")))).toBe(
      `<p><a href="/doc/abc" data-doc="/doc/abc" ${A}>go</a></p>`,
    );
  });

  it("opens other http(s) addresses as plain external links", () => {
    expect(render(para(link("https://example.org/a?b=1&c=2")))).toBe(
      `<p><a href="https://example.org/a?b=1&#38;c=2" ${A}>go</a></p>`,
    );
    expect(render(para(link("http://example.org/a")))).toContain('<a href="http://example.org/a" ');
    expect(render(para(link("https://other.example/doc/abc")))).not.toContain("data-doc");
    expect(render(para(link("/wiki/page")))).toContain(
      '<a href="https://outline.example/wiki/page" ',
    );
    expect(render(para(link("/doc/abc/extra")))).not.toContain("data-doc");
  });

  it("renders the text only for any other scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<b>x</b>",
      "mailto:a@b.c",
      "ftp://example.org/x",
      "   ",
      "",
    ]) {
      const html = render(para(link(href)));
      expect(html).toBe("<p>go</p>");
    }
  });
});

describe("marks", () => {
  it("wraps in array order", () => {
    expect(
      render(para(text("x", [{ type: "strong" }, { type: "em" }, { type: "underline" }]))),
    ).toBe("<p><u><em><strong>x</strong></em></u></p>");
    expect(
      render(
        para(
          text("a", [{ type: "strikethrough" }]),
          text("b", [{ type: "code_inline" }]),
          text("c", [{ type: "highlight" }]),
        ),
      ),
    ).toBe("<p><s>a</s><code>b</code><mark>c</mark></p>");
  });

  it("adds no wrapper for comment or unknown marks", () => {
    expect(
      render(para(text("x", [{ type: "comment", attrs: { id: "1" } }, { type: "weird" }]))),
    ).toBe("<p>x</p>");
  });
});

describe("emoji", () => {
  it("maps the known names and shows others as escaped shortcodes", () => {
    const e = (name: string): PMNode => ({ type: "emoji", attrs: { "data-name": name } });
    expect(render(para(e("star"), e("warning"), e("white_check_mark")))).toBe("<p>⭐⚠️✅</p>");
    expect(render(para(e("my<emoji>")))).toBe("<p>:my&#60;emoji&#62;:</p>");
  });
});

describe("table", () => {
  const cell = (type: string, attrs: Record<string, unknown> | undefined, label: string): PMNode =>
    attrs ? { type, attrs, content: [para(text(label))] } : { type, content: [para(text(label))] };

  it("wraps in a scroller and renders cells", () => {
    expect(
      render({
        type: "table",
        content: [
          { type: "tr", content: [cell("th", undefined, "H")] },
          { type: "tr", content: [cell("td", undefined, "D")] },
        ],
      }),
    ).toBe(
      '<div class="table-scroll"><table><tr><th><p>H</p></th></tr><tr><td><p>D</p></td></tr></table></div>',
    );
  });

  it("clamps colspan and rowspan to 1-50 and omits 1", () => {
    const row = (attrs: Record<string, unknown>): string =>
      render({ type: "table", content: [{ type: "tr", content: [cell("td", attrs, "x")] }] });
    expect(row({ colspan: 3, rowspan: 2 })).toContain('<td colspan="3" rowspan="2">');
    expect(row({ colspan: 1, rowspan: 1 })).toContain("<td>");
    expect(row({ colspan: 999, rowspan: 51 })).toContain('<td colspan="50" rowspan="50">');
    expect(row({ colspan: 0, rowspan: -4 })).toContain("<td>");
    expect(row({ colspan: "7", rowspan: 2.9 })).toContain('<td colspan="7" rowspan="2">');
    expect(row({ colspan: "abc", rowspan: null })).toContain("<td>");
    expect(row({ colspan: Number.POSITIVE_INFINITY })).toContain("<td>");
  });
});

describe("lists", () => {
  const li = (label: string): PMNode => ({ type: "list_item", content: [para(text(label))] });

  it("clamps the ordered list start to 1-1000000", () => {
    const ol = (order: unknown): string =>
      render({ type: "ordered_list", attrs: { order }, content: [li("a")] });
    expect(ol(4)).toBe('<ol start="4"><li><p>a</p></li></ol>');
    expect(ol(0)).toContain('<ol start="1">');
    expect(ol(-5)).toContain('<ol start="1">');
    expect(ol(5_000_000)).toContain('<ol start="1000000">');
    expect(ol("12")).toContain('<ol start="12">');
    expect(ol(undefined)).toContain('<ol start="1">');
    expect(ol(2.7)).toContain('<ol start="2">');
    expect(render({ type: "ordered_list", content: [li("a")] })).toContain('<ol start="1">');
  });

  it("renders bullet lists, quotes, rules and breaks", () => {
    expect(render({ type: "bullet_list", content: [li("a")] })).toBe("<ul><li><p>a</p></li></ul>");
    expect(render({ type: "blockquote", content: [para(text("q"))] })).toBe(
      "<blockquote><p>q</p></blockquote>",
    );
    expect(render({ type: "hr" }, para(text("a"), { type: "br" }, text("b")))).toBe(
      "<hr><p>a<br>b</p>",
    );
    expect(render(para())).toBe("<p><br></p>");
  });
});

describe("container_notice", () => {
  it("uses a class per known style and info otherwise", () => {
    const n = (style: unknown): string =>
      render({ type: "container_notice", attrs: { style }, content: [para(text("n"))] });
    for (const s of ["info", "warning", "tip", "success"]) {
      expect(n(s)).toBe(`<div class="notice notice-${s}"><p>n</p></div>`);
    }
    expect(n("danger")).toContain('class="notice notice-info"');
    expect(n("__proto__")).toContain('class="notice notice-info"');
    expect(n(undefined)).toContain('class="notice notice-info"');
    expect(render({ type: "container_notice", content: [para(text("n"))] })).toContain(
      "notice-info",
    );
  });
});

describe("code blocks", () => {
  it("renders escaped text for code_block and code_fence", () => {
    for (const type of ["code_block", "code_fence"]) {
      expect(render({ type, content: [text("a < b && c"), text("\nline 2")] })).toBe(
        "<pre><code>a &#60; b &#38;&#38; c\nline 2</code></pre>",
      );
    }
  });
});

describe("cards: embed, attachment, video", () => {
  const A = 'target="_blank" rel="noopener noreferrer"';
  const title = (t: string): string => `<span class="card-title">${t}</span>`;

  it("links an http(s) address and titles it from attrs, else the host", () => {
    expect(
      render({ type: "embed", attrs: { href: "https://video.example/watch?v=1", title: "Clip" } }),
    ).toBe(
      `<a class="card" href="https://video.example/watch?v=1" ${A}>${icon("\u{1F517}")}${title("Clip")}</a>`,
    );
    expect(render({ type: "embed", attrs: { href: "https://video.example/watch" } })).toContain(
      title("video.example"),
    );
    expect(
      render({ type: "video", attrs: { src: "https://v.example/a.mp4", title: "V" } }),
    ).toContain(`<a class="card" href="https://v.example/a.mp4" ${A}>`);
    expect(
      render({ type: "attachment", attrs: { href: "https://f.example/a.pdf", title: "A" } }),
    ).toContain(`<a class="card" href="https://f.example/a.pdf" ${A}>`);
  });

  it("falls back to a span for non-http(s) addresses and a default title", () => {
    expect(render({ type: "embed", attrs: { href: "javascript:alert(1)" } })).toBe(
      `<span class="card">${icon("\u{1F517}")}${title("Embedded content")}</span>`,
    );
    expect(render({ type: "attachment", attrs: { href: "data:text/html,x" } })).toBe(
      `<span class="card">${icon("\u{1F4CE}")}${title("Attachment")}</span>`,
    );
    expect(render({ type: "video", attrs: { src: "ftp://x/y" } })).toBe(
      `<span class="card">${icon("\u{1F3AC}")}${title("Video")}</span>`,
    );
    expect(render({ type: "embed" })).toContain('<span class="card">');
    expect(render({ type: "embed", attrs: { href: "https://e.example/", title: 5 } })).toContain(
      title("e.example"),
    );
  });

  it("escapes the title and the address", () => {
    const html = render({ type: "embed", attrs: { href: 'https://e.example/"x', title: "<i>" } });
    expect(html).toContain(title("&#60;i&#62;"));
    expect(html).not.toContain('"x"');
    expect(html).toContain("&#34;");
  });

  function icon(glyph: string): string {
    return `<span class="card-icon">${glyph}</span>`;
  }
});

describe("image", () => {
  it("renders an img only for an attachment redirect source", () => {
    expect(
      render({
        type: "image",
        attrs: { src: "/api/attachments.redirect?id=abc-123", alt: 'a "b"' },
      }),
    ).toBe('<img loading="lazy" src="/api/attachments.redirect?id=abc-123" alt="a &#34;b&#34;">');
  });

  it("shows any other source as a card", () => {
    const html = render({ type: "image", attrs: { src: "https://img.example/a.png", alt: "x" } });
    expect(html).not.toContain("<img");
    expect(html).toContain('<a class="card" href="https://img.example/a.png" ');
    expect(html).toContain("img.example");
    const bad = render({ type: "image", attrs: { src: "javascript:alert(1)", title: "Pic" } });
    expect(bad).toBe(
      '<span class="card"><span class="card-icon">\u{1F5BC}️</span><span class="card-title">Pic</span></span>',
    );
    expect(render({ type: "image", attrs: { src: "ftp://x/y" } })).toContain(">Image<");
  });
});

describe("maths", () => {
  it("shows the TeX source in code", () => {
    expect(render({ type: "math_inline", content: [text("a<b")] })).toBe("<code>a&#60;b</code>");
    expect(render({ type: "math_block", content: [text("x^2")] })).toBe("<code>x^2</code>");
  });
});

describe("container_toggle", () => {
  it("renders details with the first child as the summary", () => {
    expect(
      render({
        type: "container_toggle",
        content: [para(text("More")), para(text("Hidden"))],
      }),
    ).toBe('<details class="toggle"><summary>More</summary><p>Hidden</p></details>');
  });
});

describe("unknown nodes", () => {
  it("renders only the children of an unknown node that has some", () => {
    expect(render({ type: "mystery", content: [para(text("kept"))] })).toBe("<p>kept</p>");
  });

  it("renders a notice for an unknown leaf", () => {
    const expected =
      '<p class="unsupported">This part can\'t be shown here. Use Show in Outline to see it.</p>';
    expect(render({ type: "mystery" })).toBe(expected);
    expect(render({ type: "mystery", content: [] })).toContain('class="unsupported"');
  });
});

describe("safety", () => {
  it("escapes markup in text nodes", () => {
    const html = render(para(text("<script>alert(1)</script>")));
    expect(html).toBe("<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>");
    expect(html).not.toContain("<script");
  });

  it("escapes quotes and ampersands in text", () => {
    expect(render(para(text(`Tom & "Jerry's"`)))).toBe("<p>Tom &#38; &#34;Jerry&#39;s&#34;</p>");
  });

  it("never emits an inline style or an event handler attribute", () => {
    const html = render(
      { type: "heading", attrs: { level: 2 }, content: [text("H")] },
      { type: "container_notice", attrs: { style: "warning" }, content: [para(text("n"))] },
      {
        type: "table",
        content: [
          {
            type: "tr",
            content: [{ type: "td", attrs: { colspan: 2 }, content: [para(text("c"))] }],
          },
        ],
      },
      list(item("a", true)),
      { type: "image", attrs: { src: "/api/attachments.redirect?id=1", alt: "x" } },
      { type: "embed", attrs: { href: "https://e.example/" } },
    );
    expect(html).not.toContain("style=");
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("keeps no state between renders", () => {
    const first = renderGuide(
      doc(list(item("a", false), item("b", false)), {
        type: "heading",
        attrs: { level: 1 },
        content: [text("Same")],
      }),
      ctx,
    );
    const second = renderGuide(
      doc(list(item("c", false)), {
        type: "heading",
        attrs: { level: 1 },
        content: [text("Same")],
      }),
      ctx,
    );
    expect(first).toContain('data-cb="1"');
    expect(second).toContain('data-cb="0"');
    expect(second).not.toContain('data-cb="1"');
    expect(second).toContain('id="h-same"');
    expect(second).not.toContain("h-same-2");
  });
});
