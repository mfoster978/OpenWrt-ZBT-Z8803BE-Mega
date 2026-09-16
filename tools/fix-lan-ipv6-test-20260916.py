from pathlib import Path
p = Path('firmware/tests/lan-ipv6-guard.test.cjs')
s = p.read_text()
old = '"${3#*=}"'
new = '"\\${3#*=}"'
assert s.count(old) == 2, s.count(old)
p.write_text(s.replace(old, new))
