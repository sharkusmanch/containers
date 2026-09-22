import os
import sys

# Put the image dir (the parent of tests/) on sys.path so `import app.x`
# resolves regardless of how pytest is invoked (uv run, plain pytest, CI).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
