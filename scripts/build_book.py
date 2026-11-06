#!/usr/bin/env python3
"""Build the per-Elo opening book from the Lichess open database (CC0).

Reads a bounded byte range of a monthly dump as a stream (nothing is written
to disk except the resulting JSON) and counts, for every position in the first
moves of each game, which move was played and how the game ended.

A move is counted in the band of the player who made it, so a band's table
answers "what do players of this level play here?".

Usage:
    pip install chess
    python scripts/build_book.py --megabytes 1000

Requires curl and zstd on PATH.
"""
import argparse
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path

import chess

DEFAULT_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_2024-01.pgn.zst"

BAND_STEP = 250
FIRST_EDGE = 750
LAST_EDGE = 2500

# Lowest Elo counted in the reference book: "what do strong players play here?"
REFERENCE_MIN_ELO = 2000


def make_bands():
    """id, label, lowest Elo (inclusive), highest Elo (exclusive)."""
    bands = [(f"u{FIRST_EDGE}", f"Under {FIRST_EDGE}", 0, FIRST_EDGE)]
    for low in range(FIRST_EDGE, LAST_EDGE, BAND_STEP):
        bands.append((str(low), f"{low}\u2013{low + BAND_STEP}", low, low + BAND_STEP))
    bands.append((str(LAST_EDGE), f"{LAST_EDGE}+", LAST_EDGE, 9999))
    return bands


BANDS = make_bands()

COMMENT = re.compile(r"\{[^}]*\}")
MOVE_NUMBER = re.compile(r"\d+\.+")
SUFFIX = re.compile(r"[?!]+")
HEADER = re.compile(r'\[(\w+) "([^"]*)"\]')
SKIPPED_SPEEDS = ("Bullet", "UltraBullet")
RESULTS = {"1-0": 0, "1/2-1/2": 1, "0-1": 2}


def band_of(elo):
    for index, (_, _, low, high) in enumerate(BANDS):
        if low <= elo < high:
            return index
    return None


def position_key(board):
    """Placement, side to move and castling. Must match keyOf() in js/book.js."""
    return " ".join(board.fen().split(" ")[:3])


class Node:
    """Trie of move sequences, so shared prefixes are only replayed once."""

    __slots__ = ("fen", "key", "children")

    def __init__(self, board):
        self.fen = board.fen()
        self.key = position_key(board)
        self.children = {}

    def child(self, san):
        node = self.children.get(san)
        if node is None:
            board = chess.Board(self.fen)
            board.push_san(san)
            node = Node(board)
            self.children[san] = node
        return node


def stream_games(url, megabytes):
    """Yield (headers, movetext) from the first `megabytes` of a dump."""
    curl = subprocess.Popen(
        ["curl", "-sf", "-r", f"0-{megabytes * 1_000_000 - 1}", url],
        stdout=subprocess.PIPE,
    )
    # zstd exits with an error at the truncated end of the range; that is expected.
    zstd = subprocess.Popen(
        ["zstd", "-dc"], stdin=curl.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    curl.stdout.close()
    headers = {}
    try:
        for raw in zstd.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            if line.startswith("["):
                match = HEADER.match(line)
                if match:
                    headers[match.group(1)] = match.group(2)
            else:
                yield headers, line
                headers = {}
    finally:
        zstd.kill()
        curl.kill()
        zstd.wait()
        curl.wait()


def first_moves(movetext, max_plies):
    text = COMMENT.sub(" ", movetext) if "{" in movetext else movetext
    text = MOVE_NUMBER.sub(" ", text)
    tokens = text.split()
    if tokens and tokens[-1] in ("1-0", "0-1", "1/2-1/2", "*"):
        tokens.pop()
    return [SUFFIX.sub("", token) for token in tokens[:max_plies]]


def build(url, megabytes, max_plies):
    new_table = lambda: defaultdict(lambda: defaultdict(lambda: [0, 0, 0, 0]))
    counts = [new_table() for _ in BANDS]
    reference = new_table()
    games_per_band = [0] * len(BANDS)
    root = Node(chess.Board())
    used = seen = 0

    for headers, movetext in stream_games(url, megabytes):
        seen += 1
        if seen % 200_000 == 0:
            print(f"  {seen:,} games read, {used:,} used", flush=True)
        if any(speed in headers.get("Event", "") for speed in SKIPPED_SPEEDS):
            continue
        result = RESULTS.get(headers.get("Result", ""))
        if result is None:
            continue
        try:
            white_elo = int(headers["WhiteElo"])
            black_elo = int(headers["BlackElo"])
        except (KeyError, ValueError):
            continue
        moves = first_moves(movetext, max_plies)
        if len(moves) < 6:
            continue

        white = band_of(white_elo)
        black = band_of(black_elo)
        used += 1
        games_per_band[white] += 1
        games_per_band[black] += 1
        node = root
        for ply, san in enumerate(moves):
            whites_move = ply % 2 == 0
            tables = [counts[white if whites_move else black]]
            if (white_elo if whites_move else black_elo) >= REFERENCE_MIN_ELO:
                tables.append(reference)
            for table in tables:
                stats = table[node.key][san]
                stats[0] += 1
                stats[1 + result] += 1
            try:
                node = node.child(san)
            except ValueError:
                # Rolling back would complicate the counts; one odd token is harmless.
                break
    print(f"Done: {seen:,} games read, {used:,} used")
    return counts, reference, games_per_band, used


def prune(table, min_position, min_move_share, max_moves):
    """Keep only positions and moves with enough games to mean something."""
    book = {}
    for key, moves in table.items():
        total = sum(stats[0] for stats in moves.values())
        if total < min_position:
            continue
        floor = max(2, total * min_move_share)
        rows = sorted(
            ([san, *stats] for san, stats in moves.items() if stats[0] >= floor),
            key=lambda row: -row[1],
        )[:max_moves]
        if rows:
            book[key] = rows
    return book


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--megabytes", type=int, default=1000, help="compressed bytes to read")
    parser.add_argument("--plies", type=int, default=24, help="half-moves per game to count")
    parser.add_argument("--min-position", type=int, default=15, help="games needed to keep a position")
    parser.add_argument("--min-share", type=float, default=0.01, help="share needed to keep a move")
    parser.add_argument("--max-moves", type=int, default=8, help="moves kept per position")
    parser.add_argument("--out", default="data/book")
    args = parser.parse_args()

    counts, reference, games_per_band, used = build(args.url, args.megabytes, args.plies)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bands = []
    for (band_id, label, low, high), table, games in zip(BANDS, counts, games_per_band):
        book = prune(table, args.min_position, args.min_share, args.max_moves)
        path = out / f"{band_id}.json"
        path.write_text(json.dumps(book, separators=(",", ":")))
        size = path.stat().st_size
        print(f"{band_id:>6}: {games:>9,} players  {len(book):>7,} positions  {size / 1e6:.2f} MB")
        bands.append({"id": band_id, "label": label, "low": low, "high": high, "players": games, "positions": len(book)})

    book = prune(reference, args.min_position, args.min_share, args.max_moves)
    (out / "reference.json").write_text(json.dumps(book, separators=(",", ":")))
    print(f"reference ({REFERENCE_MIN_ELO}+): {len(book):,} positions")

    meta = {
        "source": args.url,
        "license": "CC0",
        "games": used,
        "plies": args.plies,
        "referenceMinElo": REFERENCE_MIN_ELO,
        "bands": bands,
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
