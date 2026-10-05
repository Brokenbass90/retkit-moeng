import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/core/retkit-moengage-core.user.js');
const userscriptSource = fs.readFileSync(file, 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
await import(pathToFileURL(file).href + `?t=${Date.now()}`);

const core = globalThis.__RetKitMoEngageCore;
assert.ok(core, 'userscript must expose testable core');

{
  const source = '<a href="https://example.com/a?x=1&amp;y=2">Go</a>';
  assert.equal(core.findSourceIndex(source, 'https://example.com/a?x=1&y=2'), source.indexOf('https://'));
}

{
  const source = '<img class="hero" src="https://cdn.example/hero.png">';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'IMG',
    src: 'https://cdn.example/hero.png',
    href: '',
    id: '',
    classes: ['hero'],
    text: '',
    backgroundUrls: [],
  });
  assert.equal(result?.kind, 'src');
  assert.equal(source.slice(result.start, result.end), 'https://cdn.example/hero.png');
}

{
  const source = '<a class="butt-link" href="https://iq.test/deposit">Start trading</a>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'SPAN',
    src: '',
    href: 'https://iq.test/deposit',
    id: '',
    classes: [],
    text: 'Start trading',
    backgroundUrls: [],
  });
  assert.equal(result?.kind, 'text');
  assert.equal(source.slice(result.start, result.end), 'Start trading');
}

{
  const source = '<table class="hero bgr-image" style="background-image:url(\'https://cdn.example/bg.png\')"><tr><td>Hello</td></tr></table>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'TD',
    src: '',
    href: '',
    id: '',
    classes: [],
    text: '',
    backgroundUrls: ['https://cdn.example/bg.png'],
  });
  assert.equal(result?.kind, 'background');
  assert.equal(source.slice(result.start, result.end), 'https://cdn.example/bg.png');
}

{
  const source = '<p class="copy">{{ContentBlock[\'welcome\']}}</p>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'P',
    src: '', href: '', id: '', classes: ['copy'],
    text: 'Rendered welcome copy', backgroundUrls: [],
  });
  assert.equal(result?.kind, 'class');
  assert.equal(source.slice(result.start, result.end), "{{ContentBlock['welcome']}}", 'class fallback should select only content between the tags');
}

{
  const source = '<div class="card">One</div><div class="card">Two</div>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'DIV',
    src: '',
    href: '',
    id: '',
    classes: ['card'],
    text: '',
    backgroundUrls: [],
  });
  assert.equal(result, null, 'duplicate class must not guess');
}

{
  const source = '<section><div id="unique-block"><p>Hello</p></div></section>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'DIV',
    src: '',
    href: '',
    id: 'unique-block',
    classes: [],
    text: '',
    backgroundUrls: [],
  });
  assert.equal(result?.kind, 'id');
  assert.match(source.slice(result.start, result.end), /id="unique-block"/);
}

{
  const source = '<div class="x"><div class="x">inner</div><p>end</p></div>';
  const start = source.indexOf('<div class="x">');
  const range = core.findElementRange(source, start, 'div');
  assert.equal(source.slice(range.start, range.end), source);
}


{
  const source = '<p class="white-text">Welcome to <b>Acme Mail</b></p>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'B',
    src: '',
    href: '',
    id: '',
    classes: [],
    text: 'Acme Mail',
    backgroundUrls: ['https://cdn.example/bg.png'],
  });
  assert.equal(result?.kind, 'text');
  assert.equal(source.slice(result.start, result.end), 'Acme Mail', 'text click should select visible text, not the whole parent block');
}

{
  const source = '<a class="butt-link" href="https://iq.test/deposit">Start trading</a>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'A',
    src: '',
    href: 'https://iq.test/deposit',
    id: '',
    classes: ['butt-link'],
    text: 'Start trading',
    backgroundUrls: [],
  });
  assert.equal(result?.kind, 'text');
  assert.equal(source.slice(result.start, result.end), 'Start trading', 'text CTA click should select CTA copy, not href or whole element');
}

{
  const calls = [];
  const fakeEditor = {
    value: 'old',
    getValue() { return this.value; },
    firstLine() { return 0; },
    lastLine() { return 0; },
    getLine() { return this.value; },
    operation(fn) { calls.push(['operation']); fn(); },
    replaceRange(next, from, to, origin) {
      calls.push(['replaceRange', next, from, to, origin]);
      this.value = next;
    },
    setValue(next) { calls.push(['setValue', next]); this.value = next; },
  };
  const changed = core.writeNativeEditorValue(fakeEditor, 'new');
  assert.equal(changed, true);
  assert.equal(fakeEditor.value, 'new');
  assert.equal(calls.some((c) => c[0] === 'replaceRange' && c[4] === '+input'), true, 'native sync should look like user input');
  assert.equal(calls.some((c) => c[0] === 'setValue'), false, 'setValue should not be the primary sync path');
}

{
  assert.equal(core.shouldAcceptRenderedPreview({ awaiting: false, renderedBeforeEdit: 'old', localPreviewUntil: 0 }, 'old', 1000), true);
  assert.equal(core.shouldAcceptRenderedPreview({ awaiting: true, renderedBeforeEdit: 'old', localPreviewUntil: 1500 }, 'old', 1000), false, 'keep local preview during the edit grace period');
  assert.equal(core.shouldAcceptRenderedPreview({ awaiting: true, renderedBeforeEdit: 'old', localPreviewUntil: 500 }, 'old', 1000), false, 'do not replace local preview with the stale MoEngage render');
  assert.equal(core.shouldAcceptRenderedPreview({ awaiting: true, renderedBeforeEdit: 'old', localPreviewUntil: 500 }, 'new', 1000), true, 'accept a genuinely refreshed MoEngage render');
}

{
  const fakeDoc = {
    documentElement: { scrollHeight: 980, offsetHeight: 900, clientHeight: 700 },
    body: { scrollHeight: 1220, offsetHeight: 1180, clientHeight: 710 },
  };
  assert.equal(core.getPreviewDocumentHeight(fakeDoc), 1220, 'preview height should fit the full rendered email');
}

{
  assert.equal(core.isAllowedHost('dashboard-02.moengage.com'), true);
  assert.equal(core.isAllowedHost('example.com'), false);
}

{
  assert.equal(core.launcherLifecycleAction({ hasNative: true, hasLauncher: false, hasWorkspace: false, routeChanged: false }), 'show');
  assert.equal(core.launcherLifecycleAction({ hasNative: false, hasLauncher: true, hasWorkspace: false, routeChanged: true }), 'remove');
  assert.equal(core.launcherLifecycleAction({ hasNative: false, hasLauncher: false, hasWorkspace: true, routeChanged: true }), 'close-workspace');
  assert.equal(core.launcherLifecycleAction({ hasNative: false, hasLauncher: false, hasWorkspace: true, routeChanged: false }), 'keep', 'temporary editor remount on the same route should not close RetKit');
}


{
  const source = '<p dir="rtl">سيظهر حينها <b class="block_13_00">زر البونص</b> في غرفة التداول</p>';
  const outside = core.findRangeFromDescriptor(source, {
    tag: 'P', src: '', href: '', id: '', classes: [],
    pointText: 'سيظهر حينها',
    pointParentTag: 'P',
    pointParentHasElementChildren: true,
    text: 'سيظهر حينها في غرفة التداول', backgroundUrls: [],
  });
  assert.equal(outside?.kind, 'mixedParent');
  assert.equal(
    source.slice(outside.start, outside.end),
    'سيظهر حينها <b class="block_13_00">زر البونص</b> في غرفة التداول',
    'clicking plain text in a mixed paragraph must select the whole paragraph content including inline tags'
  );

  const bold = core.findRangeFromDescriptor(source, {
    tag: 'B', src: '', href: '', id: '', classes: ['block_13_00'],
    pointText: 'زر البونص',
    pointParentTag: 'B',
    pointParentHasElementChildren: false,
    text: 'زر البونص', backgroundUrls: [],
  });
  assert.equal(bold?.kind, 'pointText');
  assert.equal(source.slice(bold.start, bold.end), 'زر البونص', 'clicking <b> text must select only bold copy');
}

{
  const source = '<p>Go to <b>PROMO</b>, pick the offer → Click <b>Deposit</b> and choose payment → Select &amp; <b>apply promo code</b> → Complete deposit.</p>';
  const beforeBold = core.findRangeFromDescriptor(source, {
    tag: 'P', src: '', href: '', id: '', classes: [],
    pointText: 'Go to ', pointTextOrdinal: 0,
    pointParentTag: 'P', pointParentHasElementChildren: true,
    text: 'Go to PROMO, pick the offer → Click Deposit and choose payment → Select & apply promo code → Complete deposit.',
    backgroundUrls: [],
  });
  assert.equal(beforeBold?.kind, 'mixedParent');
  assert.equal(
    source.slice(beforeBold.start, beforeBold.end),
    'Go to <b>PROMO</b>, pick the offer → Click <b>Deposit</b> and choose payment → Select &amp; <b>apply promo code</b> → Complete deposit.',
    'plain text in a paragraph with nested bold tags must select the whole paragraph content'
  );

  const bold = core.findRangeFromDescriptor(source, {
    tag: 'B', src: '', href: '', id: '', classes: [],
    pointText: 'apply promo code',
    pointParentTag: 'B', pointParentHasElementChildren: false,
    text: 'apply promo code', backgroundUrls: [],
  });
  assert.equal(bold?.kind, 'pointText');
  assert.equal(source.slice(bold.start, bold.end), 'apply promo code', 'clicking bold text must still select only the bold copy');
}


{
  // Browser-rendered DOM order can differ from source order (table repair,
  // responsive reflow, MoEngage processing). The exact text-node occurrence
  // must win over a stale/wrong element occurrence.
  const source = '<p class="copy">Same label</p><p class="copy">Same label</p>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'P', tagOccurrence: 0,
    pointText: 'Same label', pointTextOrdinal: 0, pointTextGlobalOccurrence: 1,
    src: '', href: '', id: '', classes: ['copy'], text: 'Same label', backgroundUrls: [],
  });
  assert.equal(result?.kind, 'pointText');
  assert.equal(result?.start, source.lastIndexOf('Same label'), 'exact text occurrence must beat DOM tag occurrence');
}

{
  const source = '<div><img src="same.png"><img src="same.png"><img src="same.png"></div>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'IMG', src: 'same.png', srcOccurrence: 2, href: '', id: '', classes: [], text: '', backgroundUrls: [],
  });
  assert.equal(result?.kind, 'src');
  assert.equal(result?.start, source.lastIndexOf('same.png'), 'duplicate image mapping must respect current DOM occurrence');
}

{
  const source = '<a href="same">One</a><a href="same">Two</a>';
  const result = core.findRangeFromDescriptor(source, {
    tag: 'SPAN', src: '', href: 'same', hrefOccurrence: 1, id: '', classes: [], pointText: '', text: '', backgroundUrls: [],
  });
  assert.equal(result?.kind, 'href');
  assert.equal(result?.start, source.lastIndexOf('same'), 'duplicate href mapping must respect occurrence');
}



console.log('✓ retkit-moengage userscript core');


{
  const calls = [];
  const editor = {
    refresh() { calls.push('refresh'); },
    getCursor(which) { return which === 'from' ? { line: 10, ch: 2 } : { line: 10, ch: 8 }; },
    scrollIntoView(range, margin) { calls.push(['scroll', range, margin]); },
  };
  core.refreshEditorLayout(editor);
  assert.equal(calls[0], 'refresh', 'CodeMirror must refresh after its pane width changes');
  assert.equal(calls[1][0], 'scroll', 'selection should be brought back into view after refresh');
}

{
  const source = '<table><tbody><tr><td><p>Hello <b>Acme Mail</b>!</p></td></tr></tbody></table>';
  const pretty = core.beautifyEmailHtml(source);
  assert.match(pretty, /<table>\n\s+<tbody>\n\s+<tr>\n\s+<td>/, 'beautifier should structure table markup');
  assert.ok(pretty.includes('<p>Hello <b>Acme Mail</b>!</p>'), 'beautifier must preserve inline copy exactly');
}

{
  const source = '<div><a class="x">A</a><a class="x">B</a></div>';
  const pretty = core.beautifyEmailHtml(source);
  assert.ok(pretty.includes('<a class="x">A</a><a class="x">B</a>'), 'beautifier must not add whitespace between adjacent inline links');
}

{
  const source = '<style>.x{content:"<tag>"}</style><div>Hi</div>';
  const pretty = core.beautifyEmailHtml(source);
  assert.ok(pretty.includes('<style>.x{content:"<tag>"}</style>'), 'opaque style blocks must stay intact');
}

{
  assert.deepEqual(core.findAllLiteral('foo bar foo', 'foo'), [0, 8]);
  const result = core.replaceAllLiteral('foo bar foo', 'foo', 'baz');
  assert.equal(result.value, 'baz bar baz');
  assert.equal(result.count, 2);
}

{
  const source = '<div>\n  <p>Hello</p>\n  <div>\n    <span>Nested</span>\n  </div>\n</div>';
  const lineEnd = source.indexOf('\n');
  const range = core.findFoldRangeForLine(source, 0, lineEnd);
  assert.equal(range?.tag, 'div');
  assert.equal(source.slice(range.openStart, range.openEnd), '<div>');
  assert.equal(source.slice(range.closeStart, range.closeEnd), '</div>');
}

{
  const issues = core.validateEmailHtml('<div>\n  <p>Hello\n</div>');
  assert.ok(issues.some((i) => i.code === 'unclosed-tag' && i.message.includes('<p>')), 'validator should report an unclosed nested tag');
  assert.ok(issues.every((i) => Number.isInteger(i.line) && i.line >= 1), 'validator issues must include source line numbers');
}

{
  const issues = core.validateEmailHtml('<div></span></div>');
  assert.ok(issues.some((i) => i.code === 'unexpected-close' && i.message.includes('</span>')));
}

{
  const issues = core.validateEmailHtml('<img src="x.png"><br><meta charset="utf-8">');
  assert.equal(issues.some((i) => i.code === 'unclosed-tag'), false, 'void tags must never be reported unclosed');
  assert.ok(issues.some((i) => i.code === 'img-alt' && i.severity === 'warning'), 'image without alt should warn');
}

{
  const issues = core.validateEmailHtml('<a href="one"><span>Outer <a href="two">Inner</a></span></a>');
  assert.ok(issues.some((i) => i.code === 'nested-anchor'), 'nested anchors must be reported');
}

{
  const issues = core.validateEmailHtml('<a href="#">Test</a><img alt="hero">');
  assert.ok(issues.some((i) => i.code === 'href-placeholder'), 'href # should warn');
  assert.ok(issues.some((i) => i.code === 'img-src' && i.severity === 'warning'), 'img without src should warn without blocking HTML editing');
}

{
  const issues = core.validateEmailHtml('<p class="x" data-url="{{ContentBlock[\'url\']}}">Text');
  assert.ok(issues.some((i) => i.code === 'unclosed-tag' && i.message.includes('<p>')), 'template attributes must not hide a genuinely unclosed structural tag');
}

{
  const source = '<!--[if mso]><table><tr><td><![endif]--><style>.x{content:"<fake>"}</style><div>ok</div><!--[if mso]></td></tr></table><![endif]-->';
  const issues = core.validateEmailHtml(source);
  assert.equal(issues.some((i) => i.message.includes('fake') || i.message.includes('table') || i.message.includes('td')), false, 'conditional comments and opaque style contents must not corrupt the tag stack');
}

{
  assert.match(userscriptSource, new RegExp(`@version\\s+${packageVersion.replace(/\./g, '\\.')}`));
  assert.match(userscriptSource, /@namespace\s+https:\/\/github\.com\/Brokenbass90\/retkit-moeng/);
  assert.match(userscriptSource, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/Brokenbass90\/retkit-moeng\/main\/dist\/retkit-moengage\.user\.js/);
  assert.match(userscriptSource, new RegExp(`v${packageVersion.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(userscriptSource, /makeButton\('Save'/);
  assert.doesNotMatch(userscriptSource, /makeButton\('History ▾'/);
  assert.doesNotMatch(userscriptSource, /Sync ON|50\/50|makeButton\('Desktop'|makeButton\('Mobile'/);
}
