"""Stream a native Freshdesk ZIP without extracting customer files to disk."""
import json
import re
import sys
import zipfile

count = 0
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        if not re.fullmatch(r"(?:Archive)?Tickets\d+\.json", entry.filename, re.IGNORECASE):
            raise ValueError("Unexpected native export entry")
        if entry.file_size > 128 * 1024 * 1024:
            raise ValueError("Native export entry exceeds memory budget")
        rows = json.loads(archive.read(entry))
        if not isinstance(rows, list):
            raise ValueError("Native export entry must be a ticket array")
        for row in rows:
            print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
            count += 1
print(json.dumps({"_exportTrailer": True, "total": count}))
