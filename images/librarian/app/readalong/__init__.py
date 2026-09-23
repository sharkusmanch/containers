"""Read-along worker (librarian P4): the nightly job that aligns a book's plain
EPUB with its m4b in Storyteller, gates the result, publishes it into the book
folder in the safe layout and verifies it -- `python -m app.readalong`.

gate.py, smil.py, patch.py and storyteller.py are vendored from the books repo's
read-along driver (claude/books, scripts/readalong/, commit c00c08f -- the bulk
run's final gate). Keep them in step by re-copying, not by editing here, except
where a change is marked "vendored + ...".
"""
