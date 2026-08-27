import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown";

describe("markdownToHtml", () => {
  describe("URL scheme 白名单（XSS 回归）", () => {
    // 攻击链：escHtml 挡得住裸 <script>，但 [x](javascript:...) 的 scheme
    // 不含被转义字符，会原样进入 href，再由 DocViewer 的
    // dangerouslySetInnerHTML 注入；CSP 关闭时点击即执行任意脚本。
    // DocViewer 渲染的是被打开仓库里的 markdown，所以打开不可信仓库
    // 加一次点击就够。核心断言：**绝不产出带危险 scheme 的 href/src**。

    it("拦下 javascript: 链接，只保留文本", () => {
      const out = markdownToHtml("[click](javascript:alert)");
      expect(out).not.toContain("javascript:");
      expect(out).not.toContain("<a ");
      expect(out).toContain("click");
    });

    it("大小写混写的 JavaScript: 同样拦下", () => {
      const out = markdownToHtml("[click](JaVaScRiPt:alert)");
      expect(out.toLowerCase()).not.toContain("javascript:");
      expect(out).not.toContain("<a ");
    });

    it("scheme 内插入制表符/换行不能绕过", () => {
      // 浏览器会忽略 scheme 内的 TAB/LF/CR，判定前必须做同样剥离
      for (const raw of ["java\tscript:alert", "java\nscript:alert"]) {
        const out = markdownToHtml(`[click](${raw})`);
        expect(out).not.toContain("<a ");
      }
    });

    it("前导控制字符/空白不能绕过", () => {
      const out = markdownToHtml("[click](\u0001javascript:alert)");
      expect(out).not.toContain("<a ");
    });

    it("拦下 data:text/html 与 vbscript:", () => {
      expect(markdownToHtml("[x](data:text/html,payload)")).not.toContain("<a ");
      expect(markdownToHtml("[x](vbscript:msgbox)")).not.toContain("<a ");
    });

    it("拦下 data:image/svg+xml 图片（SVG 可内嵌脚本）", () => {
      const out = markdownToHtml("![i](data:image/svg+xml,payload)");
      expect(out).not.toContain("<img");
      expect(out).toContain("i"); // 退化成 alt 文本
    });

    it("未知 scheme 一律拒绝（白名单语义）", () => {
      for (const u of ["foo:bar", "file:///etc/passwd", "chrome://settings"]) {
        expect(markdownToHtml(`[x](${u})`)).not.toContain("<a ");
      }
    });

    it("放行 http / https / mailto", () => {
      for (const u of ["http://a.b/c", "https://a.b/c", "mailto:a@b.c"]) {
        const out = markdownToHtml(`[x](${u})`);
        expect(out).toContain(`href="${u}"`);
      }
    });

    it("放行相对路径与 #fragment", () => {
      expect(markdownToHtml("[x](./doc.md)")).toContain('href="./doc.md"');
      expect(markdownToHtml("[x](../a/b.md)")).toContain('href="../a/b.md"');
      expect(markdownToHtml("[x](#sec)")).toContain('href="#sec"');
    });

    it("放行安全的 data:image 图片", () => {
      const out = markdownToHtml("![i](data:image/png;base64,iVBOR)");
      expect(out).toContain("<img");
      expect(out).toContain("data:image/png;base64,iVBOR");
    });

    it("查询串里的 & 不被双重转义", () => {
      // 修复前 escAttr 会在 escHtml 之上再转义一次 &，产出
      // href="http://x/?a=1&amp;amp;b=2"，浏览器解码成 ?a=1&amp;b=2（坏链接）
      const out = markdownToHtml("[q](http://x/?a=1&b=2)");
      expect(out).toContain('href="http://x/?a=1&amp;b=2"');
      expect(out).not.toContain("&amp;amp;");
    });
  });

  it("renders headings", () => {
    expect(markdownToHtml("# H1")).toContain("<h1");
    expect(markdownToHtml("## H2")).toContain("<h2");
    expect(markdownToHtml("### H3")).toContain("<h3");
    expect(markdownToHtml("#### H4")).toContain("<h4");
  });

  it("renders bold and italic", () => {
    const out = markdownToHtml("**bold** and *italic*");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });

  it("renders strikethrough", () => {
    expect(markdownToHtml("~~old~~")).toContain("<del>old</del>");
  });

  it("renders inline code with monospace styling", () => {
    const out = markdownToHtml("use `redis-cli`");
    expect(out).toContain("<code");
    expect(out).toContain("redis-cli");
  });

  it("renders fenced code blocks with language", () => {
    const md = "```c\nint main() { return 0; }\n```";
    const out = markdownToHtml(md);
    expect(out).toContain("<pre");
    expect(out).toContain("<code>");
    expect(out).toContain("int main()");
    expect(out).toContain("c"); // language label
  });

  it("renders unordered list", () => {
    const md = "- one\n- two\n- three";
    const out = markdownToHtml(md);
    expect(out).toContain("<ul");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
    expect(out).toContain("<li>three</li>");
  });

  it("renders ordered list", () => {
    const md = "1. first\n2. second";
    const out = markdownToHtml(md);
    expect(out).toContain("<ol");
    expect(out).toContain("<li>first</li>");
  });

  it("renders blockquote", () => {
    const out = markdownToHtml("> quoted text");
    expect(out).toContain("<blockquote");
    expect(out).toContain("quoted text");
  });

  it("renders horizontal rule", () => {
    expect(markdownToHtml("---")).toContain("<hr");
    expect(markdownToHtml("***")).toContain("<hr");
  });

  it("renders table", () => {
    const md = "| Col A | Col B |\n|-------|-------|\n| a1 | b1 |\n| a2 | b2 |";
    const out = markdownToHtml(md);
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("Col A");
    expect(out).toContain("a1");
  });

  it("renders links", () => {
    const out = markdownToHtml("[google](https://google.com)");
    expect(out).toContain('href="https://google.com"');
    expect(out).toContain("google");
  });

  it("renders wikilinks with data-wikilink attribute", () => {
    const out = markdownToHtml("See [[other-doc]].");
    expect(out).toContain('data-wikilink="other-doc"');
    expect(out).toContain("other-doc");
  });

  it("renders wikilinks with alias", () => {
    const out = markdownToHtml("See [[other|the other doc]].");
    expect(out).toContain("the other doc");
    expect(out).toContain('data-wikilink="other"');
  });

  it("escapes HTML in body", () => {
    const out = markdownToHtml("hello <script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert");
  });

  it("renders mixed content", () => {
    const md = `# Title

A paragraph with **bold**.

\`\`\`python
print("hi")
\`\`\`

- item 1
- item 2
`;
    const out = markdownToHtml(md);
    expect(out).toContain("<h1");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<pre");
    expect(out).toContain("print");
    expect(out).toContain("<li>item 1</li>");
  });

  it("leaves the flow: fence as a placeholder for DocViewer to swap", () => {
    const md = "```flow:test\nnode a label=\"A\"\n```";
    const out = markdownToHtml(md);
    // The flow: fence is replaced with a fence placeholder by the DocViewer's
    // splitContent, NOT by markdownToHtml. markdownToHtml sees only non-flow
    // fences. So a flow: fence ends up matching as a regular code block
    // with language "flow:test" — the DocViewer must pre-extract these.
    expect(out).toContain("node a");
  });
});
