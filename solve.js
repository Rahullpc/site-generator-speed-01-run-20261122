// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
//
// Written from the makefun-site README and the reference program's observable
// behaviour, in my own words and structure. No vendor code is used here:
// every path a page renders, every report line and every error string is
// reproduced from the spec, but the implementation is mine.
//
// Design notes (why it is fast):
//  - The Markdown renderer is a single fused pass: lines are split once and
//    blocks are rendered as they are scanned, so no token array is ever built.
//  - Inline markup is rendered by one scanner that batches literal runs and
//    escapes each run with a single native replace, instead of escaping
//    character by character.
//  - Word counting is a manual scan (no match array), slugs are memoised
//    within one run() call and take an ASCII fast path, and each page's card
//    is built once and reused by the index, the tag pages and the page itself.
//  - Templates are parsed once per case and interpreted by a small
//    interpreter that allocates one frame per `for` execution (not per
//    iteration) and rewrites it in place across iterations.
//  - Front matter is located with indexOf (no full split of the body) and
//    parsed from the small front-matter region only; source files are sorted
//    once up front, as the reference does.
//  - Nothing is kept from one run() call to the next: every case is answered
//    alone, exactly as the rules require.
//
// run(input) returns the output tree: { path: file text }.
// input is { site: { title, base_url, per_page, recent },
//             templates: { name: source }, files: [{ path, content }] }.

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const per = site.per_page;
  const recent = site.recent;

  // Per-case registries (fresh for every run() call).
  const templates = new Map();
  const report = []; // report lines (errors, refusals, drafts, shadowed files)
  const broken = new Set(); // deduped broken-link lines
  const output = {}; // path -> file text
  const slugMemo = new Map(); // slugify cache, valid only inside this run()

  // ------------------------------------------------------------ templates ---
  // Parsed in sorted name order; a template that does not parse is a report
  // line (its name and why), and it is simply absent from the map.
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      report.push(e.message);
    }
  }

  // ---------------------------------------------------------- read sources -
  // In code-unit order of path; a .md source gets its line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Only ~5% of sources carry \r\n ends; the replace is skipped for the
      // rest (a single indexOf is far cheaper than the regex over the body).
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // --------------------------------------------------------- front matter ---
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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

  // ----------------------------------------------------------- permalinks ---
  const takenIn = new Map(); // directory -> Set of taken slugs
  const bySource = new Map(); // source path -> page entry
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenFor(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  function takenFor(dir) {
    let t = takenIn.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      takenIn.set(dir, t);
    }
    return t;
  }

  // ------------------------------------------------------------- markdown ---
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const r = renderMarkdown(s.body, env, new Set());
    s.html = r.html;
    s.toc = r.toc;
    s.excerpt = r.excerpt;
  }

  // ----------------------------------------------------------- collections --
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // ----------------------------------------------------------------- tags ---
  // Only posts build the tag registry, in the posts' order; a page's tags
  // link to the posts' tag of the same slug, or to nothing (url "") where
  // no post has it. Tags are ordered by post count, then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let t = bySlug.get(slug);
      if (t === undefined) {
        t = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(
        (name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] },
      );
    }
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // -------------------------------------------------------------- layouts ---
  // A page's card is built once here and reused by the page itself, the
  // index pages and the tag pages (the reference builds it twice per post).
  for (const s of kept) {
    const d = s.data;
    s.card = {
      title: d.title,
      url: s.url,
      date: d.date ?? '',
      date_long: d.date === undefined ? '' : longDate(d.date),
      summary: d.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const cards = new Map(posts.map((p) => [p, p.card]));
  const siteVars = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCards = posts.slice(0, recent).map((p) => cards.get(p));
  // Every template sees site, tags (all of them, with counts) and recent at
  // its root scope, on top of the variables the render call passes.
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site: siteVars, tags: allTags, recent: recentCards, ...vars }, parent: null }, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
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
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // --------------------------------------------------------------- report ---
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;

  // ------------------------------------------------------------ page views --
  function pageOf(s) {
    return {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }
  function linkOf(s) {
    if (s === null) return null;
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    };
  }

  // ---------------------------------------------------------------- text ----
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ESC[c]);
  }

  // A whitespace test matching JavaScript's \s exactly.
  function isWS(c) {
    return c <= 32 || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
      || c === 0x3000 || c === 0xfeff;
  }

  // Count whitespace-separated runs (the same count /\S+/g would give),
  // without building a match array. The whitespace test is inlined here
  // (it is the hot loop: a function call per character cost ~3% alone),
  // and ASCII — the overwhelming majority — takes a one-comparison path:
  // below 128, only code points at or under 32 are whitespace.
  function countWords(text) {
    let n = 0;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let ws;
      if (c < 128) {
        ws = c <= 32;
      } else {
        ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
          || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
          || c === 0x3000 || c === 0xfeff;
      }
      if (ws) {
        inWord = false;
      } else if (!inWord) {
        inWord = true;
        n++;
      }
    }
    return n;
  }

  // Drop leading/trailing spaces and tabs only (the README's trim rule).
  function trimST(line) {
    let a = 0;
    let b = line.length;
    while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
    while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
    return line.slice(a, b);
  }

  function isBlank(line) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  function isOnlyST(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  function trailingSTOnly(line, from) {
    for (let i = from; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- slugify ---
  // NFKD, combining marks dropped, A-Z lowered, every run of characters
  // other than a-z and 0-9 one "-", none at either end, at most 64
  // characters (a "-" left at the cut dropped), "untitled" when nothing is
  // left. A leading run of separators leaves no dash: the dash is only
  // written when the next kept character arrives.
  function slugify(text) {
    const hit = slugMemo.get(text);
    if (hit !== undefined) return hit;
    let plain = text;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) > 127) { ascii = false; break; }
    }
    if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
    out = out.replace(/-+$/, '');
    if (out === '') out = 'untitled';
    slugMemo.set(text, out);
    return out;
  }

  function uniqueSlug(s, taken) {
    if (!taken.has(s)) {
      taken.add(s);
      return s;
    }
    let k = 2;
    while (taken.has(s + '-' + k)) k++;
    const slug = s + '-' + k;
    taken.add(slug);
    return slug;
  }

  function longDate(date) {
    const year = date.slice(0, 4);
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    return `${day} ${MONTHS[month - 1]} ${year}`;
  }

  function byCodeUnits(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // --------------------------------------------------------- front matter ---
  function parseFrontMatter(text) {
    const nl0 = text.indexOf('\n');
    const first = nl0 === -1 ? text : text.slice(0, nl0);
    if (first !== '---') return { error: 'no front matter' };
    // Locate the closing '---' line (a line that is exactly three dashes).
    let closeAt = -1;
    let q = text.indexOf('\n---', nl0);
    while (q !== -1) {
      const after = q + 4;
      if (after === text.length || text[after] === '\n') {
        closeAt = q;
        break;
      }
      q = text.indexOf('\n---', q + 1);
    }
    if (closeAt === -1) return { error: 'the front matter is not closed' };
    const fmText = text.slice(nl0 + 1, closeAt);
    const fmLines = fmText === '' ? [] : fmText.split('\n');
    const afterClose = closeAt + 4;
    const body = text[afterClose] === '\n' ? text.slice(afterClose + 1) : text.slice(afterClose);
    const data = {};
    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i];
      const lineNo = i + 2;
      if (isBlank(line) || line.charCodeAt(0) === 35) continue; // '#' comment
      const colon = line.indexOf(':');
      if (colon === -1) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, colon);
      if (key.length === 0) return { error: `line ${lineNo} is not "key: value"` };
      for (let j = 0; j < key.length; j++) {
        const c = key.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || c === 95)) return { error: `line ${lineNo} is not "key: value"` };
      }
      let raw;
      if (colon === line.length - 1) {
        raw = '';
      } else if (line.charCodeAt(colon + 1) === 32) {
        raw = line.slice(colon + 2);
      } else {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      // Drop trailing spaces/tabs from the value.
      let end = raw.length;
      while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
      raw = raw.slice(0, end);
      if (!(key in KEYS)) return { error: `unknown key "${key}"` };
      if (key in data) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const value = valueOf(key, raw);
      if (value.error !== undefined) return value;
      data[key] = value.value;
    }
    if (!('title' in data)) return { error: 'no title' };
    return { data, body };
  }

  function valueOf(key, raw) {
    switch (key) {
      case 'title':
      case 'summary': {
        const s = readString(raw);
        if (s.error !== undefined) return { error: `key "${key}": ${s.error}` };
        return { value: s.value };
      }
      case 'date': {
        const m = DATE_RE.exec(raw);
        const y = m ? Number(m[1]) : 0;
        const mo = m ? Number(m[2]) : 0;
        const d = m ? Number(m[3]) : 0;
        if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
          return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        }
        return { value: raw };
      }
      case 'tags': {
        if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
        const inner = raw.slice(1, -1);
        if (inner.trim() === '') return { value: [] };
        const tags = inner.split(',').map((t) => t.trim());
        if (tags.some((t) => t === '' || !TAG_RE.test(t))) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        return { value: tags };
      }
      case 'draft':
        return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
      case 'layout':
        return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
      case 'slug':
        return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
      default:
        return { error: `unknown key "${key}"` };
    }
  }

  // A quoted string: escapes \" and \\ only, no stray quote inside.
  function readString(raw) {
    if (raw.charCodeAt(0) === 34) {
      if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
        return { error: 'a quoted string is not closed' };
      }
      let out = '';
      for (let i = 1; i < raw.length - 1; i++) {
        const c = raw[i];
        if (c === '\\') {
          const n = raw[i + 1];
          if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
            return { error: 'a quoted string holds an escape other than \\" or \\' };
          }
          out += n;
          i++;
        } else if (c === '"') {
          return { error: 'a quoted string holds a stray quote' };
        } else {
          out += c;
        }
      }
      return { value: out };
    }
    if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
    return { value: raw };
  }

  function daysIn(y, m) {
    if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
    return 31;
  }

  // -------------------------------------------------------------- markdown --
  // The fused lex+render pass: lines are split once, blocks are rendered as
  // they are scanned. `env` resolves links; `ids` tracks heading ids for
  // this page; returns { html, toc, excerpt }.
  function renderMarkdown(src, env, ids) {
    const lines = src.split('\n');
    const n = lines.length;
    let html = '';
    const toc = [];
    let excerpt = null;
    let i = 0;
    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      const fence = fenceOpen(line);
      if (fence !== null) {
        i++;
        let code = '<pre><code' + (fence === '' ? '' : ' class="language-' + fence + '"') + '>';
        while (i < n && !isFenceClose(lines[i])) {
          code += esc(lines[i]) + '\n';
          i++;
        }
        i++; // skip the closing fence (or step past the end)
        code += '</code></pre>';
        html += code + '\n';
        continue;
      }
      const head = headingOf(line);
      if (head !== null) {
        const id = uniqueSlug(slugify(head.text), ids);
        const inner = inline(head.text, env);
        html += '<h' + head.depth + ' id="' + id + '">' + inner + '</h' + head.depth + '>\n';
        if (head.depth === 2 || head.depth === 3) toc.push({ level: head.depth, id, html: inner });
        i++;
        continue;
      }
      if (isHr(line)) { html += '<hr>\n'; i++; continue; }
      if (line.charCodeAt(0) === 62) { // '>'
        const parts = [];
        while (i < n && lines[i].charCodeAt(0) === 62) {
          let l = lines[i].slice(1);
          if (l.charCodeAt(0) === 32) l = l.slice(1);
          l = trimST(l);
          if (l !== '') parts.push(l);
          i++;
        }
        html += parts.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : '<blockquote>\n<p>' + inline(parts.join('\n'), env) + '</p>\n</blockquote>\n';
        continue;
      }
      const list = listMarker(line);
      if (list !== null) {
        const items = [];
        let cur = [trimST(list.text)];
        i++;
        while (i < n) {
          const m = listMarker(lines[i]);
          if (m !== null && m.ordered === list.ordered) {
            items.push(cur.join('\n'));
            cur = [trimST(m.text)];
            i++;
          } else if (isContinued(lines[i])) {
            cur.push(trimST(lines[i]));
            i++;
          } else break;
        }
        items.push(cur.join('\n'));
        const open = list.ordered
          ? (list.start !== 1 ? '<ol start="' + list.start + '">' : '<ol>')
          : '<ul>';
        let s = open + '\n';
        for (const it of items) s += '<li>' + inline(it, env) + '</li>\n';
        s += list.ordered ? '</ol>' : '</ul>';
        html += s + '\n';
        continue;
      }
      // Paragraph: runs until a blank line, a fence, a heading or an HR.
      const parts = [trimST(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) {
        parts.push(trimST(lines[i]));
        i++;
      }
      const phtml = inline(parts.join('\n'), env);
      if (excerpt === null) excerpt = phtml;
      html += '<p>' + phtml + '</p>\n';
    }
    return { html, toc, excerpt: excerpt === null ? '' : excerpt };
  }

  function endsParagraph(line) {
    if (isBlank(line)) return true;
    if (fenceOpen(line) !== null) return true;
    if (headingOf(line) !== null) return true;
    if (isHr(line)) return true;
    return false;
  }

  // A fence opens on three backticks followed by a language name (letters,
  // digits, underscore, plus or minus) and then only spaces or tabs.
  function fenceOpen(line) {
    if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
    let j = 3;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
      j++;
    }
    if (j === 3) return trailingSTOnly(line, 3) ? '' : null;
    return trailingSTOnly(line, j) ? line.slice(3, j) : null;
  }

  function isFenceClose(line) {
    if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
    return trailingSTOnly(line, 3);
  }

  // A heading is 1-6 '#'s, at least one space or tab, then text (trailing
  // spaces/tabs dropped; closing '#'s stay part of the text). The text is
  // never empty: a heading line with nothing after the spaces is no heading.
  function headingOf(line) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) === 35) j++;
    if (j === 0 || j > 6) return null;
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    let k = j + 1;
    while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    let end = line.length;
    while (end > k && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end <= k) return null;
    return { depth: j, text: line.slice(k, end) };
  }

  function isHr(line) {
    if (line.startsWith('---')) return trailingSTOnly(line, 3);
    if (line.startsWith('***')) return trailingSTOnly(line, 3);
    return false;
  }

  // A list marker: '- ' or '* ' (bullet), or 1-9 digits + '. ' (ordered).
  function listMarker(line) {
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
      return { ordered: false, start: 1, text: line.slice(2) };
    }
    if (c0 >= 48 && c0 <= 57) {
      let j = 1;
      while (j < 9 && j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        return { ordered: true, start: Number(line.slice(0, j)), text: line.slice(j + 2) };
      }
    }
    return null;
  }

  // A list continuation: 2 or more spaces, then a non-whitespace character.
  function isContinued(line) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) === 32) j++;
    return j >= 2 && j < line.length && !isWS(line.charCodeAt(j));
  }

  // -------------------------------------------------------------- inline ----
  // One scanner. Literal runs are batched and escaped with a single native
  // replace; markup tokens are rendered as they are met.
  function inline(s, env) {
    if (!MARKUP_RE.test(s)) return esc(s);
    let out = '';
    let i = 0;
    let lit = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\' && i + 1 < n && ESCAPABLE_TABLE[s.charCodeAt(i + 1)] === 1) {
        if (lit < i) out += esc(s.slice(lit, i));
        const e = s[i + 1];
        out += e === '>' ? '&gt;' : e;
        i += 2;
        lit = i;
        continue;
      }
      if (c === '`') {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) {
          if (lit < i) out += esc(s.slice(lit, i));
          out += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
          i = j + 1;
          lit = i;
        } else {
          i++;
        }
        continue;
      }
      if (c === '*') {
        if (s[i + 1] === '*') {
          const j = findUnescaped(s, '**', i + 2);
          if (j > i + 2) {
            if (lit < i) out += esc(s.slice(lit, i));
            out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
            i = j + 2;
            lit = i;
          } else {
            i += 2;
          }
        } else {
          const j = findSingleStar(s, i + 1);
          if (j > i + 1) {
            if (lit < i) out += esc(s.slice(lit, i));
            out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
            i = j + 1;
            lit = i;
          } else {
            i++;
          }
        }
        continue;
      }
      if (c === '[') {
        const k = findUnescaped(s, ']', i + 1);
        if (k !== -1 && s[k + 1] === '(') {
          const m = s.indexOf(')', k + 2);
          const target = m === -1 ? '' : s.slice(k + 2, m);
          if (target !== '' && !WS_RE.test(target)) {
            if (lit < i) out += esc(s.slice(lit, i));
            out += '<a href="' + esc(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
            i = m + 1;
            lit = i;
            continue;
          }
        }
        i++;
        continue;
      }
      i++;
    }
    if (lit < n) out += esc(s.slice(lit));
    return out;
  }

  // Find `what` at or after `from`, skipping backslash-escaped characters.
  function findUnescaped(s, what, from) {
    for (let j = from; j <= s.length - what.length; j++) {
      if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE_TABLE[s.charCodeAt(j + 1)] === 1) {
        j++;
        continue;
      }
      if (s.startsWith(what, j)) return j;
    }
    return -1;
  }

  // Find a single '*' (not part of '**') at or after `from`, skipping
  // backslash-escaped characters and whole '**' pairs.
  function findSingleStar(s, from) {
    for (let j = from; j < s.length; j++) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && ESCAPABLE_TABLE[s.charCodeAt(j + 1)] === 1) {
        j++;
        continue;
      }
      if (c !== '*') continue;
      if (s[j + 1] === '*') {
        j++;
        continue;
      }
      return j;
    }
    return -1;
  }

  // -------------------------------------------------------------- templates -
  // Tokenise a template: {{ var }}, {{{ raw }}}, {% tag %}. A {% %} tag
  // alone on its line (only spaces or tabs beside it) takes its whole line
  // with it, its line ending included.
  function tokenize(name, src) {
    const toks = [];
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
        if (close === -1) throw new Error(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
        if (text !== '') toks.push({ t: 'text', value: text });
        text = '';
        toks.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
        i = close + (raw ? 3 : 2);
        continue;
      }
      const close = src.indexOf('%}', open + 2);
      if (close === -1) throw new Error(`template "${name}": a {% is not closed`);
      const end = close + 2;
      const lineStart = src.lastIndexOf('\n', open - 1) + 1;
      const nl = src.indexOf('\n', end);
      const lineEnd = nl === -1 ? src.length : nl;
      const standalone = isOnlyST(src.slice(lineStart, open)) && isOnlyST(src.slice(end, lineEnd));
      if (standalone) text = text.slice(0, text.length - (open - lineStart));
      if (text !== '') toks.push({ t: 'text', value: text });
      text = '';
      toks.push({ t: 'tag', value: src.slice(open + 2, close).trim() });
      i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
    }
    if (text !== '') toks.push({ t: 'text', value: text });
    return toks;
  }

  // The path `text` names, split at its dots, or an error when it is not a
  // path (each part starts with a letter or _, then letters, digits or _).
  function pathOf(name, text) {
    if (!PATH_RE.test(text)) throw new Error(`template "${name}": ${JSON.stringify(text)} is not a path`);
    return text.split('.');
  }

  // Parse the token stream into a node tree. Errors carry the template's
  // name and the reason, as the reference reports them.
  function parseTemplate(name, src) {
    const root = { kind: 'root', body: [] };
    const stack = [root];
    let body = root.body;
    for (const tok of tokenize(name, src)) {
      if (tok.t === 'text') {
        body.push({ kind: 'text', value: tok.value });
        continue;
      }
      if (tok.t === 'var' || tok.t === 'raw') {
        body.push({ kind: tok.t, path: tok.path });
        continue;
      }
      const tag = tok.value;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new Error(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new Error(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new Error(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
    if (stack.length > 1) throw new Error(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
    return root.body;
  }

  // Look up a dotted path: the first segment comes from the innermost scope
  // that owns it, the rest from the value's own properties.
  function lookup(scope, path) {
    let s = scope;
    const first = path[0];
    while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
    if (s === null) return undefined;
    let v = s.vars[first];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }

  // A value as text: a string itself, a number in JavaScript's digits, true
  // or false, an array's items joined by ", ", anything else "".
  function textOf(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return v.map(textOf).join(', ');
    return '';
  }

  function truthy(v) {
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
  }

  // Render a node tree into a string. `depth` is the include depth (cap 8).
  function renderNodes(nodes, scope, depth) {
    let out = '';
    for (const n of nodes) {
      switch (n.kind) {
        case 'text':
          out += n.value;
          break;
        case 'var': {
          const v = lookup(scope, n.path);
          out += typeof v === 'string' ? esc(v) : esc(textOf(v));
          break;
        }
        case 'raw': {
          const v = lookup(scope, n.path);
          out += typeof v === 'string' ? v : textOf(v);
          break;
        }
        case 'if': {
          const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
          if (branch !== null) out += renderNodes(branch, scope, depth);
          break;
        }
        case 'for': {
          const xs = lookup(scope, n.path);
          if (Array.isArray(xs)) {
            // One frame per execution, rewritten in place per iteration:
            // the item and the loop record ({index, first, last, length})
            // are mutated instead of allocating a scope per item.
            const vars = {};
            vars[n.name] = undefined;
            const lp = { index: 0, first: false, last: false, length: xs.length };
            vars.loop = lp;
            const child = { vars, parent: scope };
            const last = xs.length - 1;
            for (let k = 0; k <= last; k++) {
              vars[n.name] = xs[k];
              lp.index = k + 1;
              lp.first = k === 0;
              lp.last = k === last;
              out += renderNodes(n.body, child, depth);
            }
          }
          break;
        }
        case 'include': {
          const t = templates.get(n.name);
          if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, depth + 1);
          break;
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ link logic --
  function resolvePath(dir, rel) {
    // Fast path: a clean relative path (no "..", no empty segment, no "./")
    // needs no splitting at all — it is just dir + "/" + rel.
    if (rel !== '.' && rel.indexOf('..') === -1 && rel.indexOf('//') === -1 && !rel.startsWith('./')
      && rel.indexOf('/./') === -1 && !rel.endsWith('/.')) {
      return dir === '' ? rel : `${dir}/${rel}`;
    }
    const parts = dir === '' ? [] : dir.split('/');
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    return parts.join('/');
  }

  function dirOf(path) {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
}

// --------------------------------------------------------------- constants --
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KEYS = { title: 1, date: 1, tags: 1, summary: 1, layout: 1, slug: 1, draft: 1 };
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9-]+$/;
const TAG_RE = /^[^"[\]]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
// A character the backslash escape may escape (the set from the README).
const ESCAPABLE_TABLE = (() => {
  const t = new Uint8Array(128);
  for (const ch of '\\`*_[]()#+-.!>') t[ch.charCodeAt(0)] = 1;
  return t;
})();
// Any inline-markup character (fast path for plain text).
const MARKUP_RE = /[`*\[\\]/;
// Any whitespace, for the link-target rule.
const WS_RE = /\s/;
