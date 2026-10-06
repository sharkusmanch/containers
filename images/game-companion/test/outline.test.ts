import { describe, expect, it } from "vitest";
import { OutlineClient } from "../src/server/outline.js";
import { fakeFetch, fixture } from "./helpers.js";

const opts = { baseUrl: "https://outline.example.test", apiKey: "ol_api_x" };

describe("OutlineClient", () => {
  it("follows pagination when listing children", async () => {
    const f = fakeFetch([
      ['"offset":100', { body: fixture("outline-list-page2.json") }],
      ['"offset":0', { body: fixture("outline-list-page1.json") }],
    ]);
    const docs = await new OutlineClient({ ...opts, fetchFn: f.fn }).listChildren("p1");
    expect(docs).toHaveLength(3);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.url).toBe("https://outline.example.test/api/documents.list");
    expect((f.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer ol_api_x",
    );
  });

  it("stops on an empty page even when the reported total is never reached", async () => {
    const f = fakeFetch([
      ['"offset":100', { body: '{"pagination":{"limit":100,"offset":100,"total":9},"data":[]}' }],
      [
        '"offset":0',
        { body: fixture("outline-list-page1.json").replace('"total":3', '"total":9') },
      ],
    ]);
    const docs = await new OutlineClient({ ...opts, fetchFn: f.fn }).listChildren("p1");
    expect(docs).toHaveLength(2);
    expect(f.calls).toHaveLength(2);
  });

  it("returns the collection tree", async () => {
    const f = fakeFetch([["collections.documents", { body: fixture("outline-collection.json") }]]);
    const tree = await new OutlineClient({ ...opts, fetchFn: f.fn }).collectionTree("c1");
    expect(tree.map((n) => n.title)).toEqual(["Other", "Achievement Guides"]);
  });

  it("returns a document's text", async () => {
    const f = fakeFetch([
      [
        "documents.info",
        { body: '{"data":{"id":"s1","title":"S","url":"/doc/s","text":"## Now Playing"}}' },
      ],
    ]);
    expect(await new OutlineClient({ ...opts, fetchFn: f.fn }).docText("s1")).toBe(
      "## Now Playing",
    );
  });
});
