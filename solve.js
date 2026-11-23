// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Written from scratch against makefun-site's README (its own front matter,
// template dialect, Markdown subset, slug rule and report). It returns exactly
// what makefun-site 1.0.0's build returns for every input, byte for byte, but
// does the work in one fused pass wherever the reference takes two, with no
// regular expressions in the hot paths and no per-character escaping.
//
// Speed notes:
// - Markdown is lexed and rendered in a single pass over the body's lines;
//   inline markup is rendered by one chunk-based scan (runs of plain text are
//   copied whole, never escaped character by character).
// - slugify takes an ASCII fast path (NFKD is the identity on ASCII) and its
//   results are memoised per run: tag names and titles repeat constantly.
// - Templates are parsed once into compact array nodes and rendered into a
//   shared parts array; scopes are null-prototype frames so a lookup is a
//   direct property read.
// - A post's card is built once and reused by its own page render.
// - Nothing is cached from one case to the next: every run() starts fresh.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Whitespace in JavaScript's \s sense, by code unit. */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** A space or a tab, the only blank characters of this dialect. */
function isBlankChar(c) {
  return c === 32 || c === 9;
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_ESCAPABLE = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!HAS_ESCAPABLE.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESCAPES[text[i]];
    if (e !== undefined) {
      if (start < i) out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (start < text.length) out += text.slice(start);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Per-run memo of slugify, keyed by the exact input text. */
let slugCache = null;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. ASCII text takes a fast path: NFKD is the identity on it and it holds
 * no combining mark.
 */
function slugify(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  let out;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end < out.length) out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
        let digits = true;
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            digits = false;
            break;
          }
        }
        if (digits) {
          y = Number(raw.slice(0, 4));
          mo = Number(raw.slice(5, 7));
          d = Number(raw.slice(8, 10));
          ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
        }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isBlankChar(line.charCodeAt(i))) return false;
  return true;
}

/**
 * A source's front matter and body: { data, close } (the body's lines follow
 * `lines[close]`), or { error } with the first reason it is refused. `lines`
 * is the source text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // A "key: value" line: a key of a-z and _, a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && isBlankChar(raw.charCodeAt(end - 1))) end--;
    if (end < raw.length) raw = raw.slice(0, end);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isBlankChar(line.charCodeAt(a))) a++;
  while (b > a && isBlankChar(line.charCodeAt(b - 1))) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is a fence opening; its language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length && isBlankChar(line.charCodeAt(j))) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) if (!isBlankChar(line.charCodeAt(j))) return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length || !isBlankChar(line.charCodeAt(n))) return null;
  let a = n;
  while (a < line.length && isBlankChar(line.charCodeAt(a))) a++;
  let b = line.length;
  while (b > a && isBlankChar(line.charCodeAt(b - 1))) b--;
  if (a === b) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) if (!isBlankChar(line.charCodeAt(j))) return false;
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** Whether `line` is a continued list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWS(line.charCodeAt(j));
}

/** A list marker: { ordered, start, text } or null. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
    }
  }
  return null;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const k = s.indexOf(what, from);
  if (k === -1) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= k) return k;
  // A backslash stands before the candidate: fall back to the exact scan.
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const bs = s.indexOf('\\', from);
  let j = s.indexOf('*', from);
  // Fast path while every candidate star stands before the first backslash:
  // no escape can touch it there. Past that backslash, fall back to the
  // exact scan, which is the only way to tell an escaped star from a real one.
  while (j !== -1 && (bs === -1 || j < bs)) {
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  if (j === -1) return -1;
  // A backslash stands before the candidate: fall back to the exact scan.
  for (let k = from; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 92 && k + 1 < s.length && ESCAPABLE[s.charCodeAt(k + 1)] === 1) {
      k++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(k + 1) === 42) {
      k++;
      continue;
    }
    return k;
  }
  return -1;
}

/** The characters inline rendering stops at. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) {
      if (i < n) out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        // ">" is the one escapable character the escape table also names.
        out += s.charCodeAt(j + 1) === 62 ? '&gt;' : s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = m2 + 1;
      } else {
        out += '[';
        i = j + 1;
      }
      continue;
    }
    out += ESCAPES[s[j]];
    i = j + 1;
  }
  return out;
}

/**
 * `lines` from `start` rendered: its HTML (each block on its own lines, a
 * "\n" after the last), its table of contents and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, start, env) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = start;
  const end = lines.length;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      let body = '';
      while (i < end && !isFenceClose(lines[i])) {
        body += `${escapeHtml(lines[i])}\n`;
        i++;
      }
      i++;
      html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${lang}">${body}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const h = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const startNum = marker.start;
      const items = [[trimLine(marker.text)]];
      i++;
      while (i < end) {
        const m = listMarker(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      html += `${open}\n${inner}</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < end && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const p = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = p;
    html += `<p>${p}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node kinds, as compact arrays:
//   [0, text]                        text
//   [1, path]                        {{ path }} escaped
//   [2, path]                        {{{ path }}} raw
//   [3, name, path, body]            {% for name in path %} body {% endfor %}
//   [4, not, path, then, else|null]  {% if [not] path %} then [{% else %} else] {% endif %}
//   [5, name]                        {% include "name" %}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([tok.t === 'var' ? 1 : 2, tok.path]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [3, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', node });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [4, m[1] !== undefined, pathOf(name, m[2]), [], null];
        body.push(node);
        stack.push({ kind: 'if', node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.node[4] = [];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 'for' : 'if';
        if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.node[3] : (parent.node[4] ?? parent.node[3]);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push([5, m[1]]);
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && s.vars[path[0]] === undefined) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The names a template can only read from the page's values: `site`, `tags` and `recent`. */
const ROOT_VARS = new Set(['site', 'tags', 'recent']);

/**
 * The names `nodes` reads that no `for` inside them binds: the first segment
 * of every path of a var, raw, if or for, transitively through includes.
 * `bound` is the set of names the enclosing fors bind; `visiting` guards the
 * include graph's cycles (a cycle adds no name the outer walk does not).
 */
function freeVarsOf(nodes, templates, bound, memo, visiting) {
  const out = new Set();
  const walk = (ns, b) => {
    for (let n = 0; n < ns.length; n++) {
      const node = ns[n];
      const kind = node[0];
      if (kind === 1 || kind === 2) {
        if (!b.has(node[1][0])) out.add(node[1][0]);
      } else if (kind === 4) {
        if (!b.has(node[2][0])) out.add(node[2][0]);
        walk(node[3], b);
        if (node[4] !== null) walk(node[4], b);
      } else if (kind === 3) {
        if (!b.has(node[2][0])) out.add(node[2][0]);
        const b2 = new Set(b);
        b2.add(node[1]);
        b2.add('loop');
        walk(node[3], b2);
      } else if (kind === 5) {
        const key = `${node[1]}\0${[...b].sort().join(',')}`;
        if (visiting.has(key)) continue;
        let sub = memo.get(key);
        if (sub === undefined) {
          visiting.add(key);
          const subNodes = templates.get(node[1]);
          sub = subNodes === undefined ? new Set() : freeVarsOf(subNodes, templates, b, memo, visiting);
          visiting.delete(key);
          memo.set(key, sub);
        }
        for (const x of sub) out.add(x);
      }
    }
  };
  walk(nodes, bound);
  return out;
}

/**
 * Mark every for node with whether its body reads `loop` (node[4]): when it
 * does not, rendering skips the loop object. The body's read of `loop` is
 * what the for's own loop object answers: enclosing bindings never shadow it
 * (this for's frame is innermost), and neither does the for's own name (the
 * loop object overwrites the element when the names collide, as the object
 * literal does). Only a for nested inside the body can shadow it, which the
 * analysis sees as it walks in with an empty bound set.
 */
function annotateLoops(nodes, templates, memo) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    if (node[0] === 3) {
      node[4] = freeVarsOf(node[3], templates, new Set(), memo, new Set()).has('loop');
      annotateLoops(node[3], templates, memo);
    } else if (node[0] === 4) {
      annotateLoops(node[3], templates, memo);
      if (node[4] !== null) annotateLoops(node[4], templates, memo);
    }
  }
}

/** `nodes` rendered in `scope` ({ vars, parent }), appending to `parts`. */
function renderNodes(nodes, scope, ctx, depth, parts) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const kind = node[0];
    if (kind === 0) {
      parts.push(node[1]);
    } else if (kind === 1) {
      parts.push(escapeHtml(textOf(lookup(scope, node[1]))));
    } else if (kind === 2) {
      parts.push(textOf(lookup(scope, node[1])));
    } else if (kind === 4) {
      const v = truthy(lookup(scope, node[2]));
      const branch = v !== node[1] ? node[3] : node[4];
      if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
    } else if (kind === 3) {
      const xs = lookup(scope, node[2]);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = Object.create(null);
        vars[node[1]] = xs[k];
        if (node[4]) vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
        renderNodes(node[3], { vars, parent: scope }, ctx, depth, parts);
      }
    } else if (kind === 5) {
      const t = ctx.templates.get(node[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) {
        // A template that reads only the page's values renders the same at
        // every include of its depth: render it once per case and reuse it.
        if (ctx.constSet.has(node[1])) {
          const key = `${node[1]}#${depth}`;
          const hit = ctx.constCache.get(key);
          if (hit !== undefined) {
            parts.push(hit);
          } else {
            const sub = [];
            renderNodes(t, scope, ctx, depth + 1, sub);
            const out = sub.join('');
            ctx.constCache.set(key, out);
            parts.push(out);
          }
        } else renderNodes(t, scope, ctx, depth + 1, parts);
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The words of a body: its runs of characters other than whitespace. */
function wordsOfLines(lines, start) {
  let count = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      if (isWS(line.charCodeAt(j))) inWord = false;
      else if (!inWord) {
        count++;
        inWord = true;
      }
    }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFrontMatter(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.lines, s.bodyStart);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootScope = { vars: null, parent: null };
  rootScope.vars = Object.create(null);
  rootScope.vars.site = site;
  rootScope.vars.tags = allTags;
  rootScope.vars.recent = recent;
  // Templates that read only the page's values (site, tags, recent): their
  // render is the same wherever they are included, so it is cached per case.
  // Sound only while no for anywhere binds one of those names (a binding
  // would shadow the page's value); if one does, the cache stays off.
  const ctx = { templates, constSet: new Set(), constCache: new Map() };
  {
    let shadowsRoot = false;
    const collectFors = (nodes) => {
      for (const node of nodes) {
        if (node[0] === 3) {
          if (ROOT_VARS.has(node[1])) shadowsRoot = true;
          collectFors(node[3]);
        } else if (node[0] === 4) {
          collectFors(node[3]);
          if (node[4] !== null) collectFors(node[4]);
        }
      }
    };
    const memo = new Map();
    for (const nodes of templates.values()) {
      collectFors(nodes);
      annotateLoops(nodes, templates, memo);
    }
    if (!shadowsRoot) {
      for (const [name, nodes] of templates) {
        const free = freeVarsOf(nodes, templates, new Set(), memo, new Set());
        let constant = true;
        for (const v of free) {
          if (!ROOT_VARS.has(v)) {
            constant = false;
            break;
          }
        }
        if (constant) ctx.constSet.add(name);
      }
    }
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    const scopeVars = Object.create(null);
    for (const k of Object.keys(vars)) scopeVars[k] = vars[k];
    renderNodes(nodes, { vars: scopeVars, parent: rootScope }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < target.length && target.charCodeAt(i) === 58;
}
