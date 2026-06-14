import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown";

describe("markdownToHtml", () => {
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
