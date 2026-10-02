"""Find, and optionally remove, top-level functions that nothing references.

  python scripts/check/dead-functions.py <repo> [--keep=name ...]            # list
  python scripts/check/dead-functions.py <repo> [--keep=name ...] --remove   # remove, repeat until stable

A function is unreferenced when its name appears exactly once across the page
and the other scripts the page loads: the definition itself. Names are matched
as whole words, so a call, an inline handler, a string in an onclick attribute
or a `window.name` lookup all count as references.
"""
import io, re, sys, os

NL = chr(10)
repo = sys.argv[1]
remove = '--remove' in sys.argv
KEEP = set(x.split('=', 1)[1] for x in sys.argv if x.startswith('--keep='))
path = os.path.join(repo, 'index.html')
others = [os.path.join(repo, f) for f in ('landing.html', 'animations.js', 'openalex.js', 'seed-data.js') if os.path.exists(os.path.join(repo, f))]
other_text = NL.join(io.open(f, encoding='utf-8').read() for f in others)

DEF = re.compile('^(?:async[ ]+)?function[ ]+([A-Za-z_$][A-Za-z0-9_$]*)[ ]*[(]', re.M)

def scan(s):
    dead = []
    for m in DEF.finditer(s):
        name = m.group(1)
        if name in KEEP: continue
        pat = re.compile('(?<![A-Za-z0-9_$])' + re.escape(name) + '(?![A-Za-z0-9_$])')
        if len(pat.findall(s)) + len(pat.findall(other_text)) == 1:
            dead.append((name, m.start()))
    return dead

def span(s, start):
    """[a, b) covering one top-level function and the comment block directly above it."""
    line_start = s.rfind(NL, 0, start) + 1
    line_end = s.find(NL, start)
    first = s[line_start:line_end]
    if first.count('{') == first.count('}') and first.rstrip().endswith('}'):
        end = line_end + 1                      # the whole function is on one line
    else:
        end = s.find(NL + '}', start)           # first closing brace at column 0
        assert end != -1
        end += 2
        if s[end:end + 1] == NL: end += 1
    cut = line_start
    while cut > 0:
        prev_end = cut - 1
        prev_start = s.rfind(NL, 0, prev_end) + 1
        if s[prev_start:prev_end].strip().startswith('//'): cut = prev_start
        else: break
    return cut, end

s = io.open(path, encoding='utf-8', newline='').read()
removed = []
while True:
    dead = scan(s)
    if not dead: break
    if not remove:
        for name, pos in dead:
            a, b = span(s, pos)
            print('%-28s line %5d  %3d lines' % (name, s.count(NL, 0, pos) + 1, s.count(NL, a, b)))
        break
    name, pos = dead[0]
    a, b = span(s, pos)
    removed.append((name, s.count(NL, a, b)))
    s = s[:a] + s[b:]

if remove:
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
    for name, n in removed: print('removed %-28s %3d lines' % (name, n))
    print('total', len(removed), 'functions,', sum(n for _, n in removed), 'lines')

if not remove:
    sys.exit(1 if dead else 0)
