"""Build the offline base dictionary with Python's csv/sqlite standard library.

No third-party CSV parser or full prebuilt dictionary download is needed. The
source lock pins every redistributed source byte; derived forms use exchange
from the MIT CSV, not the separately restricted research-only lemma file.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import unicodedata
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads(Path(__file__).with_name("source-lock.json").read_text("utf-8"))


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalized(value):
    return unicodedata.normalize("NFKC", value).lower().strip()


def source_files(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in LOCK["files"].items():
        file = directory / name
        url = f'https://raw.githubusercontent.com/skywind3000/ECDICT/{LOCK["commit"]}/{name}'
        if not file.exists():
            pending = file.with_suffix(file.suffix + ".download")
            try:
                with urllib.request.urlopen(url, timeout=60) as response, pending.open("wb") as out:
                    shutil.copyfileobj(response, out)
                os.replace(pending, file)
            finally:
                pending.unlink(missing_ok=True)
        if file.stat().st_size != expected["bytes"] or sha256(file) != expected["sha256"]:
            raise ValueError(f"Source byte/hash mismatch: {name}; remove the bad cached file before retrying")


def build(directory, output):
    source_files(directory)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + "." + uuid.uuid4().hex + ".tmp")
    db = sqlite3.connect(temporary)
    try:
        db.executescript("""
            PRAGMA page_size=4096;
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE entries(id INTEGER PRIMARY KEY, word TEXT NOT NULL,
              normalized TEXT NOT NULL, phonetic TEXT NOT NULL, definition TEXT NOT NULL,
              translation TEXT NOT NULL, pos TEXT NOT NULL, tags TEXT NOT NULL,
              exchange TEXT NOT NULL, rank INTEGER NOT NULL, is_phrase INTEGER NOT NULL);
            CREATE TABLE forms(form TEXT NOT NULL, entry_id INTEGER NOT NULL,
              kind TEXT NOT NULL, PRIMARY KEY(form,entry_id,kind)) WITHOUT ROWID;
            CREATE TABLE lemma_links(form TEXT NOT NULL, lemma TEXT NOT NULL);
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        """)
        entries, forms, lemmas = [], [], []
        count = 0
        with (directory / "ecdict.csv").open("r", encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                word = row["word"].strip()
                if not word:
                    continue
                count += 1
                norm = normalized(word)
                ranks = [int(row[field]) for field in ("bnc", "frq") if row[field].isdigit() and int(row[field]) > 0]
                entries.append((count, word, norm, row["phonetic"], row["definition"], row["translation"], row["pos"], row["tag"], row["exchange"], min(ranks) if ranks else 2147483647, int(" " in norm)))
                for exchange in row["exchange"].split("/"):
                    kind, separator, values = exchange.partition(":")
                    if not separator or kind == "1":
                        continue
                    for value in values.split(","):
                        form = normalized(value)
                        if form:
                            if kind == "0":
                                lemmas.append((norm, form))
                            else:
                                forms.append((form, count, kind))
                if len(entries) >= 5000:
                    db.executemany("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)", entries)
                    db.executemany("INSERT OR IGNORE INTO forms VALUES(?,?,?)", forms)
                    db.executemany("INSERT INTO lemma_links VALUES(?,?)", lemmas)
                    entries.clear(); forms.clear(); lemmas.clear()
        db.executemany("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)", entries)
        db.executemany("INSERT OR IGNORE INTO forms VALUES(?,?,?)", forms)
        db.executemany("INSERT INTO lemma_links VALUES(?,?)", lemmas)
        db.executescript("""
            CREATE INDEX entries_normalized ON entries(normalized);
            INSERT OR IGNORE INTO forms SELECT l.form,e.id,'lemma'
              FROM lemma_links l JOIN entries e ON e.normalized=l.lemma;
            DROP TABLE lemma_links;
        """)
        counts = {"entries": count, "forms": db.execute("SELECT count(*) FROM forms").fetchone()[0],
                  "phrases": db.execute("SELECT count(*) FROM entries WHERE is_phrase=1").fetchone()[0]}
        db.executemany("INSERT INTO metadata VALUES(?,?)", [("schemaVersion", "1"), ("sourceCommit", LOCK["commit"]), *[(key, str(value)) for key, value in counts.items()]])
        db.commit()
        db.execute("VACUUM")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Generated dictionary failed SQLite integrity_check")
        db.close()
        os.replace(temporary, output)
        shutil.copyfile(directory / "LICENSE", output.parent / "ECDICT-LICENSE.txt")
        report = {"schemaVersion": 1, "source": LOCK, "database": output.name,
                  "bytes": output.stat().st_size, "sha256": sha256(output), **counts,
                  "retained": ["word", "phonetic", "definition", "translation", "pos", "tag", "exchange", "frequency rank"],
                  "derived": ["exchange inflection/lemma index", "shared normalized word/phrase prefix index"],
                  "notRedistributed": ["original CSV", "research-only lemma.en.txt", "audio", "detail"]}
        output.with_name("provenance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        db.close()
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, default=ROOT / "local-build/spark233/translation/source")
    parser.add_argument("--output", type=Path, default=ROOT / "packages/official/translation/data/ecdict.sqlite")
    args = parser.parse_args()
    build(args.source_dir.resolve(), args.output.resolve())
