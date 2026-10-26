/**
 * Outline's ProseMirror JSON as HTML for the guide reader.
 *
 * Adapted from Inkharbor's `src/lib/editor/render-html.ts` (MIT; see THIRD-PARTY-NOTICES.md). The
 * output is set as the `innerHTML` of an element under a strict CSP, so it carries no inline
 * styles or scripts, every string from the document is escaped, and every address is checked
 * before it becomes an `href` or `src`. All numbering (headings, checkboxes) is per call.
 */
import { checkboxItems, type PMNode } from "./guide-checkbox.js";
import { isSafeDocUrl } from "./state.js";

export interface RenderContext {
  /** The Outline origin, e.g. `https://outline.example`; links to it are in-app links. */
  origin: string;
}

const EMOJI: Record<string, string> = {
  star: "⭐",
  warning: "⚠️",
  white_check_mark: "✅",
};

const NOTICE_STYLES = new Set(["info", "warning", "tip", "success"]);
const LABEL_LIMIT = 80;
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
/** A link hash the reader can follow: a heading id such as `h-area-two`, nothing else. */
const HASH = /^[A-Za-z0-9_-]+$/;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const attr = (node: PMNode, name: string): unknown => node.attrs?.[name];
const str = (node: PMNode, name: string): string => {
  const value = attr(node, name);
  return typeof value === "string" ? value : "";
};

function textOf(node: PMNode): string {
  return node.text ?? (node.content ?? []).map(textOf).join("");
}

/** The attribute as a whole number within [min, max]; `fallback` when it is not a number. */
function wholeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function slugOf(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "section" : slug;
}

/** The first `LABEL_LIMIT` characters of a checkbox's own text, whitespace collapsed. */
function checkboxLabel(item: PMNode): string {
  const first = item.content?.[0];
  const plain = first ? textOf(first).replace(/\s+/g, " ").trim() : "";
  const cut = Array.from(plain).slice(0, LABEL_LIMIT).join("").trim();
  return cut === "" ? "Checkbox" : cut;
}

class Renderer {
  private readonly checkboxIndex = new Map<PMNode, number>();
  private readonly headingIds = new Set<string>();
  private readonly headingCounts = new Map<string, number>();
  private readonly origin: string;

  constructor(
    root: PMNode,
    private readonly ctx: RenderContext,
  ) {
    this.origin = ctx.origin;
    checkboxItems(root).forEach((item, index) => this.checkboxIndex.set(item, index));
  }

  render(node: PMNode): string {
    switch (node.type) {
      case "text":
        return this.marked(node, escape(node.text ?? ""));
      case "paragraph":
        return `<p>${this.children(node) || "<br>"}</p>`;
      case "heading":
        return this.heading(node);
      case "blockquote":
        return `<blockquote>${this.children(node)}</blockquote>`;
      case "bullet_list":
        return `<ul>${this.children(node)}</ul>`;
      case "ordered_list": {
        const start = wholeNumber(attr(node, "order") ?? attr(node, "start"), 1, 1_000_000, 1);
        return `<ol start="${start}">${this.children(node)}</ol>`;
      }
      case "list_item":
        return `<li>${this.children(node)}</li>`;
      case "checkbox_list":
        return `<ul class="checklist">${this.children(node)}</ul>`;
      case "checkbox_item":
        return this.checkboxItem(node);
      case "code_block":
      case "code_fence":
        return `<pre><code>${escape(textOf(node))}</code></pre>`;
      case "hr":
        return "<hr>";
      case "br":
        return "<br>";
      case "emoji": {
        const name = str(node, "data-name") || str(node, "name");
        const shown = Object.hasOwn(EMOJI, name) ? (EMOJI[name] ?? "") : `:${name}:`;
        return this.marked(node, escape(shown));
      }
      case "mention":
        return `<span class="mention">@${escape(str(node, "label"))}</span>`;
      case "image":
        return this.image(node);
      case "math_inline":
      case "math_block":
        return `<code>${escape(textOf(node))}</code>`;
      case "table":
        return `<div class="table-scroll"><table>${this.children(node)}</table></div>`;
      case "tr":
        return `<tr>${this.children(node)}</tr>`;
      case "th":
      case "td":
        return this.cell(node);
      case "container_notice": {
        const style = str(node, "style");
        const kind = NOTICE_STYLES.has(style) ? style : "info";
        return `<div class="notice notice-${kind}">${this.children(node)}</div>`;
      }
      case "container_toggle": {
        const [summary, ...rest] = node.content ?? [];
        const body = rest.map((child) => this.render(child)).join("");
        return `<details class="toggle"><summary>${summary ? this.children(summary) : ""}</summary>${body}</details>`;
      }
      case "attachment":
        return this.card("\u{1F4CE}", node, attr(node, "href"), "Attachment");
      case "video":
        return this.card("\u{1F3AC}", node, attr(node, "src"), "Video");
      case "embed":
        return this.card("\u{1F517}", node, attr(node, "href"), "Embedded content");
      default:
        if ((node.content ?? []).length > 0) return this.children(node);
        return `<p class="unsupported">This part can't be shown here. Use Show in Outline to see it.</p>`;
    }
  }

  private children(node: PMNode): string {
    return (node.content ?? []).map((child) => this.render(child)).join("");
  }

  private heading(node: PMNode): string {
    const level = wholeNumber(attr(node, "level"), 1, 6, 1);
    const base = `h-${slugOf(textOf(node))}`;
    let id = base;
    let count = this.headingCounts.get(base) ?? 1;
    while (this.headingIds.has(id)) {
      count += 1;
      id = `${base}-${count}`;
    }
    this.headingCounts.set(base, count);
    this.headingIds.add(id);
    return `<h${level} id="${escape(id)}">${this.children(node)}</h${level}>`;
  }

  private checkboxItem(node: PMNode): string {
    const checked = attr(node, "checked") === true;
    // An item the numbering never saw gets no index: a tap on it must not tick another item.
    const index = this.checkboxIndex.get(node);
    const cb = index === undefined ? "" : ` data-cb="${index}"`;
    return (
      `<li class="cb-item${checked ? " checked" : ""}">` +
      `<button type="button" class="cb" role="checkbox" aria-checked="${checked}" ` +
      `aria-label="${escape(checkboxLabel(node))}"${cb}></button>` +
      `<div class="cb-body">${this.children(node)}</div></li>`
    );
  }

  private cell(node: PMNode): string {
    const span = (name: string): string => {
      const value = wholeNumber(attr(node, name), 1, 50, 1);
      return value > 1 ? ` ${name}="${value}"` : "";
    };
    return `<${node.type}${span("colspan")}${span("rowspan")}>${this.children(node)}</${node.type}>`;
  }

  private image(node: PMNode): string {
    const src = attr(node, "src");
    if (typeof src === "string" && src.startsWith("/api/attachments.redirect?id=")) {
      const alt = attr(node, "alt");
      return `<img loading="lazy" src="${escape(src)}" alt="${escape(typeof alt === "string" ? alt : "")}">`;
    }
    return this.card("\u{1F5BC}️", node, src, "Image");
  }

  private card(icon: string, node: PMNode, address: unknown, fallbackTitle: string): string {
    const href = this.externalHref(address);
    const given = attr(node, "title");
    const title = typeof given === "string" ? given : (hostOf(href) ?? fallbackTitle);
    const inner = `<span class="card-icon">${icon}</span><span class="card-title">${escape(title)}</span>`;
    return href === null
      ? `<span class="card">${inner}</span>`
      : `<a class="card" href="${escape(href)}" ${EXTERNAL}>${inner}</a>`;
  }

  /** The address to open outside the app: http(s) only. Relative paths resolve against Outline. */
  private externalHref(address: unknown): string | null {
    if (typeof address !== "string") return null;
    const trimmed = address.trim();
    if (trimmed === "") return null;
    let parsed: URL;
    try {
      parsed = new URL(trimmed, this.origin);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return /^https?:\/\//i.test(trimmed) ? trimmed : parsed.href;
  }

  /** Wraps `inner` in the node's marks, in array order; a link with an unsafe address drops. */
  private marked(node: PMNode, inner: string): string {
    let html = inner;
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case "strong":
          html = `<strong>${html}</strong>`;
          break;
        case "em":
          html = `<em>${html}</em>`;
          break;
        case "underline":
          html = `<u>${html}</u>`;
          break;
        case "strikethrough":
          html = `<s>${html}</s>`;
          break;
        case "code_inline":
          html = `<code>${html}</code>`;
          break;
        case "highlight":
          html = `<mark>${html}</mark>`;
          break;
        case "link":
          html = this.link(mark.attrs?.["href"], html);
          break;
      }
    }
    return html;
  }

  /**
   * A link to a guide page carries its path in `data-doc` and a heading hash in `data-hash`; a
   * bare `#hash` is an in-page link the reader scrolls to. Hashes are heading ids only.
   */
  private link(address: unknown, inner: string): string {
    if (typeof address !== "string" || address.trim() === "") return inner;
    const trimmed = address.trim();
    if (trimmed.startsWith("#")) {
      const hash = trimmed.slice(1);
      if (!HASH.test(hash)) return inner;
      return `<a href="#${escape(hash)}" data-hash="${escape(hash)}">${inner}</a>`;
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed, this.origin);
    } catch {
      return inner;
    }
    if (parsed.origin === new URL(this.origin).origin && isSafeDocUrl(parsed.pathname)) {
      const path = escape(parsed.pathname);
      const raw = parsed.hash.slice(1);
      if (!HASH.test(raw)) return `<a href="${path}" data-doc="${path}" ${EXTERNAL}>${inner}</a>`;
      const hash = escape(raw);
      return `<a href="${path}#${hash}" data-doc="${path}" data-hash="${hash}" ${EXTERNAL}>${inner}</a>`;
    }
    const href = this.externalHref(address);
    return href === null ? inner : `<a href="${escape(href)}" ${EXTERNAL}>${inner}</a>`;
  }
}

function hostOf(href: string | null): string | null {
  if (href === null) return null;
  try {
    return new URL(href).host || null;
  } catch {
    return null;
  }
}

/** The document as HTML for display. Pure: numbering and heading ids start fresh on every call. */
export function renderGuide(root: PMNode, ctx: RenderContext): string {
  return new Renderer(root, ctx).render(root);
}
