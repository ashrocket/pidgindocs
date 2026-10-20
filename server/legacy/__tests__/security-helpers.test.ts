import { describe, expect, it } from "vitest";
import { htmlToPlainText, removeRawTextElements } from "../html-text";
import { unbiasedIndex } from "../invites";

describe("HTML text extraction", () => {
  it("removes script and style raw text with HTML end-tag whitespace and attributes", () => {
    expect(removeRawTextElements(
      "before<script>alert(1)</script data-x='>'>middle<STYLE>.x{}</style >after"
    )).toBe("beforemiddleafter");
  });

  it("drops an unclosed raw-text element through end of input", () => {
    expect(removeRawTextElements("visible<script>not visible")).toBe("visible");
    expect(htmlToPlainText("<script")).toBe("&lt;script");
  });

  it("does not treat script-like text inside an attribute or comment as an element", () => {
    const html = '<p title="<script>attribute text</script>">visible</p><!-- <script>comment</script> -->';
    expect(removeRawTextElements(html)).toBe(html);
  });

  it("treats stray quotes in malformed attributes as HTML parse errors", () => {
    expect(htmlToPlainText(`<p broken'>visible</p><script>secret</script>after`)).toBe("visible\n\nafter");
    expect(htmlToPlainText(`<p value=bad'quote>visible</p><style>secret</style>after`)).toBe("visible\n\nafter");
    expect(removeRawTextElements(`before<script>secret</script broken'>after`)).toBe("beforeafter");
    expect(htmlToPlainText(`<p value="unterminated<script>secret`)).toBe('&lt;p value="unterminated&lt;script>secret');
  });

  it("handles tag-heavy and unterminated input with bounded scans", () => {
    const tags = "<p>x</p>".repeat(20_000);
    expect(removeRawTextElements(tags + "<SCRIPT>secret</SCRIPT>")).toBe(tags);
    expect(htmlToPlainText("<p title=\"" + "<p".repeat(20_000))).toBe('&lt;p title="' + "&lt;p".repeat(20_000));
    expect(removeRawTextElements("<SCRIPT>x</SCRIPT>".repeat(20_000))).toBe("");
  });

  it("keeps encoded angle brackets inert in email plain text", () => {
    expect(htmlToPlainText("<p>Hello &amp; welcome</p><script>alert(1)</script>&lt;script&gt;safe&lt;/script&gt;"))
      .toBe("Hello & welcome\n\n&lt;script&gt;safe&lt;/script&gt;");
  });
});

describe("unbiased invite indexes", () => {
  it("rejects out-of-range bytes and maps every accepted byte evenly", () => {
    const counts = new Array(36).fill(0);
    for (let byte = 0; byte < 252; byte++) counts[unbiasedIndex(36, () => byte)]++;
    expect(counts).toEqual(new Array(36).fill(7));

    const rejected = [252, 255, 251];
    let cursor = 0;
    expect(unbiasedIndex(36, () => rejected[cursor++])).toBe(35);
    expect(cursor).toBe(3);
  });

  it("rejects invalid bounds", () => {
    expect(() => unbiasedIndex(0, () => 0)).toThrow(RangeError);
    expect(() => unbiasedIndex(257, () => 0)).toThrow(RangeError);
  });
});
