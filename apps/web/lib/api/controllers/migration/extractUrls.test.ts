import { describe, expect, it } from "vitest";
import { extractUrlsFromText } from "./extractUrls";

describe("extractUrlsFromText", () => {
  it("returns an empty array for empty input", () => {
    expect(extractUrlsFromText("")).toEqual([]);
    expect(extractUrlsFromText("   \n\n  ")).toEqual([]);
  });

  it("extracts newline-separated URLs", () => {
    const input = [
      "https://example.com/",
      "https://github.com/linkwarden/linkwarden",
      "https://news.ycombinator.com/",
    ].join("\n");

    expect(extractUrlsFromText(input)).toEqual([
      "https://example.com/",
      "https://github.com/linkwarden/linkwarden",
      "https://news.ycombinator.com/",
    ]);
  });

  it("de-duplicates repeated URLs", () => {
    const input = [
      "https://example.com/",
      "https://example.com/",
      "https://example.com/other",
    ].join("\n");

    expect(extractUrlsFromText(input)).toEqual([
      "https://example.com/",
      "https://example.com/other",
    ]);
  });

  it("normalises bare www. hosts to https://", () => {
    expect(extractUrlsFromText("www.example.com")).toEqual([
      "https://www.example.com/",
    ]);
  });

  it("skips non-URL lines", () => {
    const input = `
      Here are my reading-list links:
      https://example.com/one
      Not a url at all
      https://example.com/two
    `;
    expect(extractUrlsFromText(input)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  it("handles comma- and space-separated lists via trailing-comma stripping", () => {
    // The tokenizer only splits on whitespace; trailing commas are
    // removed by the wrapper-punctuation fallback when the
    // raw-with-comma token fails to parse as a URL.
    const input =
      "https://a.example.com, https://b.example.com https://c.example.com";
    expect(extractUrlsFromText(input)).toEqual([
      "https://a.example.com/",
      "https://b.example.com/",
      "https://c.example.com/",
    ]);
  });

  it("preserves commas inside URL query strings (coordinate pairs, CSV-like values)", () => {
    // Real-world case the old comma-splitting tokenizer silently
    // corrupted: Google Maps coordinates. Both URLs must survive intact.
    expect(
      extractUrlsFromText(
        "https://maps.google.com/?q=48.8566,2.3522\nhttps://example.com/?a=1,2,3"
      )
    ).toEqual([
      "https://maps.google.com/?q=48.8566,2.3522",
      "https://example.com/?a=1,2,3",
    ]);
  });

  it("preserves semicolons inside URL paths and params", () => {
    expect(
      extractUrlsFromText("https://example.com/path;param=value;other=x")
    ).toEqual(["https://example.com/path;param=value;other=x"]);
  });

  it("strips surrounding punctuation/markdown", () => {
    const input =
      "See <https://example.com/>, also (https://github.com) — and https://foo.test.";
    expect(extractUrlsFromText(input)).toEqual([
      "https://example.com/",
      "https://github.com/",
      "https://foo.test/",
    ]);
  });

  it("preserves URLs with parentheses in paths (e.g. Wikipedia)", () => {
    expect(
      extractUrlsFromText(
        "https://en.wikipedia.org/wiki/Example_(disambiguation)"
      )
    ).toEqual([
      "https://en.wikipedia.org/wiki/Example_(disambiguation)",
    ]);
  });

  it("handles wrapped URLs with parentheses via fallback stripping", () => {
    expect(extractUrlsFromText("(https://github.com)")).toEqual([
      "https://github.com/",
    ]);
  });

  it("rejects non-http(s) schemes", () => {
    const input =
      "ftp://example.com/file\njavascript:alert(1)\nfile:///etc/hosts\nhttps://safe.example";
    expect(extractUrlsFromText(input)).toEqual(["https://safe.example/"]);
  });

  it("ignores trailing whitespace-only tokens", () => {
    expect(
      extractUrlsFromText("https://example.com/\n   \n  \thttps://x.test\n")
    ).toEqual(["https://example.com/", "https://x.test/"]);
  });
});
