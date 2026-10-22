#!/usr/bin/env python3
"""Builds QuantaBuild-Estimator.html: Estimator.dc.html with support.js inlined,
so the page works as one downloaded file (no support.js needed beside it).
Re-run after editing Estimator.dc.html or support.js."""
import pathlib

root = pathlib.Path(__file__).parent
page = (root / 'Estimator.dc.html').read_text()
runtime = (root / 'support.js').read_text()
tag = '<script src="./support.js"></script>'
assert page.count(tag) == 1, 'support.js script tag not found'
inline = '<script>\n' + runtime.replace('</script', '<\\/script') + '\n</script>'
(root / 'QuantaBuild-Estimator.html').write_text(page.replace(tag, inline))
print('wrote QuantaBuild-Estimator.html')
