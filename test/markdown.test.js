// The tiny Markdown renderer must be safe and not corrupt ordinary text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "../web/js/markdown.js";

test("escapes HTML", () => {
  const out = renderMarkdown("<img src=x onerror=alert(1)>");
  assert.ok(out.includes("&lt;img"));
  assert.ok(!out.includes("<img"));
});

test("renders bold, italic and inline code", () => {
  assert.match(renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown("*italic*"), /<em>italic<\/em>/);
  assert.match(renderMarkdown("run `npm test`"), /<code>npm test<\/code>/);
});

test("inline code is escaped exactly once", () => {
  const out = renderMarkdown('split on `"="` and keep `a < b && c`');
  assert.match(out, /<code>&quot;=&quot;<\/code>/);
  assert.match(out, /<code>a &lt; b &amp;&amp; c<\/code>/);
  assert.ok(!out.includes("&amp;quot;"));
});

test("does not mangle snake_case or plain digits", () => {
  const out = renderMarkdown("use snake_case_name with 3 args and step 1");
  assert.match(out, /snake_case_name/);
  assert.ok(!out.includes("<em>"));
  assert.ok(!out.includes("undefined"));
  assert.match(out, /3 args/);
});

test("neutralizes javascript: links but keeps https", () => {
  assert.match(renderMarkdown("[x](javascript:alert(1))"), /href="#"/);
  assert.match(renderMarkdown("[s](https://example.com)"), /href="https:\/\/example.com"/);
});

test("escapes inside code fences", () => {
  const out = renderMarkdown("```js\n<script>evil()</script>\n```");
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(out.includes("md-pre"));
});

test("renders lists", () => {
  assert.match(renderMarkdown("- a\n- b"), /<ul class="md-list"><li>a<\/li><li>b<\/li><\/ul>/);
});

test("escapeHtml handles the basics", () => {
  assert.equal(escapeHtml('<a>&"'), "&lt;a&gt;&amp;&quot;");
});
