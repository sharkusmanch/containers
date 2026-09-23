"""Read-along worker: the Read-Along custom field stays explicit true/false."""
from app.readalong.flag import FIELD_KEY, field_id, sync_flags


class Lib:
    def __init__(self, details=None):
        self.set = []
        self.details = details or {}

    def set_flag(self, book_id, fid, value):
        self.set.append((book_id, fid, value))

    def detail(self, book_id):
        return self.details[book_id]


def rec(bid, overlay, value="absent"):
    files = [{"id": 1, "format": "epub", "mediaOverlay": {"available": overlay}}]
    cm = [] if value == "absent" else [{"fieldId": 2, "key": FIELD_KEY, "value": value}]
    return {"id": bid, "files": files, "customMetadata": cm}


def test_only_books_whose_flag_differs_are_patched():
    lib = Lib()
    books = [rec(1, True, True), rec(2, False, False), rec(3, True, False), rec(4, False, None)]
    assert sync_flags(lib, books, 2, libraries=(7, 8), dry_run=False) == (2, 0)
    assert lib.set == [(3, 2, True), (4, 2, False)]


def test_a_book_without_the_field_is_patched_only_in_a_flagged_library():
    lib = Lib(details={5: {"id": 5, "libraryId": 7}, 6: {"id": 6, "libraryId": 3}})
    assert sync_flags(lib, [rec(5, False), rec(6, False)], 2, libraries=(7, 8), dry_run=False) == (1, 0)
    assert lib.set == [(5, 2, False)]                    # the comic (library 3) is left alone


def test_dry_run_patches_nothing_and_failures_are_counted():
    lib = Lib()
    assert sync_flags(lib, [rec(3, True, False)], 2, libraries=(7, 8), dry_run=True) == (1, 0)
    assert lib.set == []

    class Boom(Lib):
        def set_flag(self, *a):
            raise RuntimeError("409")
    assert sync_flags(Boom(), [rec(3, True, False), rec(4, True, False)], 2, libraries=(7, 8),
                      dry_run=False) == (0, 2)


def test_field_id_by_key_and_missing_is_an_error():
    class C:
        def __init__(self, fields):
            self.fields = fields

        def get(self, path):
            assert path == "/custom-metadata/fields"
            return self.fields
    assert field_id(C([{"id": 9, "key": "other"}, {"id": 2, "key": FIELD_KEY, "archivedAt": None}])) == 2
    try:
        field_id(C([{"id": 2, "key": FIELD_KEY, "archivedAt": "2026-01-01"}]))
    except RuntimeError as e:
        assert FIELD_KEY in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_a_book_deleted_since_the_listing_does_not_stop_the_sync():
    class Gone(Lib):
        def detail(self, book_id):
            if book_id == 5:
                raise RuntimeError("GET /books/5 -> HTTP 404: gone")
            return super().detail(book_id)
    lib = Gone(details={6: {"id": 6, "libraryId": 7}})
    assert sync_flags(lib, [rec(5, False), rec(6, True)], 2, libraries=(7, 8), dry_run=False) == (1, 1)
    assert lib.set == [(6, 2, True)]
