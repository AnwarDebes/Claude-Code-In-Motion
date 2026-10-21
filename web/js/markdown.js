// Tiny, dependency-free Markdown renderer. Escapes HTML first, then handles the
// common subset: code fences, inline code, headings, bold/italic, links, lists,
// blockquotes, and paragraphs.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A Private-Use sentinel that cannot occur in ordinary text, so inline-code
// placeholders never collide with real content like "3 options" or "step 1".
const SENT = String.fromCharCode(0xe000);

function inline(text) {
  let s = escapeHtml(text);
  // Pull inline code out first so its contents are not further formatted.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return SENT + (codes.length - 1) + SENT;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
    const safe = /^(https?:|mailto:)/i.test(url) ? url : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Underscore-italic intentionally omitted: it mangles snake_case identifiers.
  // The code text was captured from the already-escaped string, so it must not
  // be escaped a second time (that would show &quot; instead of a quote).
  s = s.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_, i) => `<code>${codes[+i]}</code>`);
  return s;
}

export function renderMarkdown(src) {
  const lines = String(src ?? "").split("\n");
  let html = "";
  let i = 0;
  let listType = null;

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  while (i < lines.length) {
    let line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] || "";
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      html += `<pre class="md-pre"><code data-lang="${escapeHtml(lang)}">${escapeHtml(buf.join("\n"))}</code></pre>`;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level} class="md-h">${inline(h[2])}</h${level}>`;
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      html += `<blockquote class="md-quote">${inline(buf.join(" "))}</blockquote>`;
      continue;
    }

    // horizontal rule
    if (/^(\*\*\*|---|___)\s*$/.test(line)) {
      closeList();
      html += `<hr class="md-hr">`;
      i++;
      continue;
    }

    // unordered / ordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); html += `<${want} class="md-list">`; listType = want; }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      i++;
      continue;
    }

    // blank line
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // paragraph (gather consecutive non-special lines)
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
      !/^(```|#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+\.\s|(\*\*\*|---|___)\s*$)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    html += `<p class="md-p">${inline(buf.join("\n")).replace(/\n/g, "<br>")}</p>`;
  }
  closeList();
  return html;
}
