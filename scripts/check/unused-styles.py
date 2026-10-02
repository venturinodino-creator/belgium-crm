"""Find, and optionally remove, style rules that nothing on any page can match.

  python scripts/check/unused-styles.py <repo>            # list
  python scripts/check/unused-styles.py <repo> --remove   # rewrite styles.css

The styles analysed are styles.css and any <style> block left in index.html.
A class is USED when its name appears anywhere outside them (in
markup, in a script string, in a classList call), in another file the page
loads, or when it can be assembled at runtime: it starts with a prefix that the
source concatenates with data, such as  b-${type}  or  'badge-' + level.

A selector is dead when it requires at least one unused class. A rule goes
only when every selector in its list is dead; otherwise just the dead
selectors are dropped. @keyframes, @font-face and anything not a plain rule
are never touched.
"""
import io, re, sys, os

NL = chr(10)
repo = sys.argv[1]
remove = '--remove' in sys.argv
path = os.path.join(repo, 'index.html')
src = io.open(path, encoding='utf-8', newline='').read()
others = ''
for f in ('landing.html', 'animations.js', 'openalex.js', 'animations.css', 'seed-data.js'):
    p = os.path.join(repo, f)
    if os.path.exists(p): others += io.open(p, encoding='utf-8').read() + NL

STYLE = re.compile('<style[^>]*>(.*?)</style>', re.S)
blocks = list(STYLE.finditer(src))
non_style = STYLE.sub(' ', src) + NL + others
css_path = os.path.join(repo, 'styles.css')
css_src = io.open(css_path, encoding='utf-8', newline='').read() if os.path.exists(css_path) else None

CLASS = re.compile('[.](-?[_a-zA-Z][_a-zA-Z0-9-]*)')

# Prefixes the source builds class names from at runtime.
# 'leaflet-' is here because the Leaflet map library, loaded from a CDN, creates
# those elements itself: the names never appear in this repo's source.
prefixes = {'leaflet-'}
for m in re.finditer('([_a-zA-Z][_a-zA-Z0-9-]*-)[$][{]', non_style): prefixes.add(m.group(1))
for m in re.finditer('([_a-zA-Z][_a-zA-Z0-9]*-)[$][{]', non_style): prefixes.add(m.group(1))
for m in re.finditer("([_a-zA-Z][_a-zA-Z0-9]*-)['\"`] *[+]", non_style): prefixes.add(m.group(1))
for m in re.finditer("([_a-zA-Z][_a-zA-Z0-9-]*-)['\"`] *[+]", non_style): prefixes.add(m.group(1))

def words(text):
    return set(re.findall('[_a-zA-Z][_a-zA-Z0-9-]*', text))
WORDS = words(non_style)
# a hyphenated token also proves each of its hyphen-joined tails and heads are spelled out
def used(cls):
    if cls in WORDS: return True
    return any(cls.startswith(p) for p in prefixes)

def split_selectors(sel):
    out, depth, cur = [], 0, ''
    for ch in sel:
        if ch in '([': depth += 1
        elif ch in ')]': depth -= 1
        if ch == ',' and depth == 0: out.append(cur); cur = ''
        else: cur += ch
    out.append(cur)
    return out

dead_classes = {}
def process(css):
    """Returns css with dead selectors removed. Handles one level of @media/@supports nesting."""
    out, i, n = [], 0, len(css)
    while i < n:
        # comments pass through
        if css.startswith('/*', i):
            j = css.find('*/', i); j = n if j == -1 else j + 2
            out.append(css[i:j]); i = j; continue
        j = css.find('{', i)
        if j == -1: out.append(css[i:]); break
        # a comment may sit between here and the brace
        c = css.find('/*', i)
        if c != -1 and c < j:
            out.append(css[i:c]); i = c; continue
        prelude = css[i:j]
        # find the matching close brace
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{': depth += 1
            elif css[k] == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        head = prelude.strip()
        if head.startswith('@'):
            if head.startswith('@media') or head.startswith('@supports'):
                out.append(prelude + '{' + process(body) + '}')
            else:
                out.append(css[i:k])
            i = k; continue
        lead = prelude[:len(prelude) - len(prelude.lstrip())]
        sels = split_selectors(prelude.strip())
        keep = []
        for sel in sels:
            needs = CLASS.findall(sel)
            missing = [c for c in needs if not used(c)]
            if missing:
                for c in missing: dead_classes.setdefault(c, []).append(sel.strip())
            else:
                keep.append(sel)
        if keep and len(keep) == len(sels):
            out.append(css[i:k])
        elif keep:
            out.append(lead + ','.join(s.strip() if idx else s.strip() for idx, s in enumerate(keep)) + '{' + body + '}')
        else:
            # drop the rule and the newline that followed it
            if css[k:k + 1] == NL: k += 1
            # keep indentation tidy: also drop leading whitespace already emitted for this rule
            if lead.strip() == '' and NL in lead:
                out.append(lead[:lead.rfind(NL) + 1])
        i = k
    return ''.join(out)

new_src, last = [], 0
for m in blocks:
    new_src.append(src[last:m.start(1)])
    new_src.append(process(m.group(1)))
    last = m.end(1)
new_src.append(src[last:])
new_src = ''.join(new_src)
new_css = process(css_src) if css_src is not None else None

print('style blocks:', len(blocks), '| stylesheet:', 'styles.css' if css_src is not None else 'none', '| runtime prefixes:', sorted(prefixes))
print('unused classes (%d):' % len(dead_classes))
for c in sorted(dead_classes):
    print('  .%-26s %s' % (c, ' | '.join(sorted(set(dead_classes[c])))[:110]))
removed = src.count(NL) - new_src.count(NL) + ((css_src.count(NL) - new_css.count(NL)) if css_src is not None else 0)
print('lines removed: %d' % removed)
if remove:
    io.open(path, 'w', encoding='utf-8', newline='').write(new_src)
    if css_src is not None: io.open(css_path, 'w', encoding='utf-8', newline='').write(new_css)
    print('rewritten')

if not remove:
    sys.exit(1 if dead_classes else 0)
