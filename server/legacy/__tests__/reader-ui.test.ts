import { describe, expect, it } from "vitest";
import { addReaderUi, readerScript } from "../web/reader-ui";
describe("reader controls",()=>{
 it("inserts controls after authored script content and before the document's final body close",()=>{
  const html='<html><head><title>Example</title></head><body><script>const example="</body>";</script><h1>Title</h1><p>Text</p></body></html>';
  const result=addReaderUi(html,"PidginDocs","/inbox");expect(result).toContain('const example="</body>";');expect(result.indexOf("function init")).toBeGreaterThan(result.indexOf("<p>Text</p>"));expect(result).toContain("text.textContent = readable");expect(result).not.toContain("text.innerHTML");
 });
 it("serializes labels without closing the trusted script",()=>{
  const script=readerScript('</script><img src=x onerror=alert(1)>',"/inbox");expect(script.match(/<\/script>/g)).toHaveLength(1);expect(script).toContain("\\u003c/script>");
 });
});
