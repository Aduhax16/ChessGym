#!/usr/bin/env python3
"""Audit data/openings.json with Stockfish.

For every move the student has to play (after the opening's forced prefix),
compares the engine's evaluation of the best move with that of the written
move, and lists any move that loses too much.

    pip install chess
    python scripts/check_lines.py --engine /path/to/stockfish

Gambits and tricky openings are allowed a larger loss, because giving up
something objectively is the point of them. Lines marked "trap": true are
skipped: they are deliberately unsound, and their text has to say so.
"""
import argparse
import json
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parent.parent
LOOSE_STYLES = {"Gambit", "Tricky"}
MATE = 3000


def score(info, color):
    return info["score"].pov(color).score(mate_score=MATE)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--nodes", type=int, default=400_000)
    parser.add_argument("--threshold", type=int, default=70, help="max centipawn loss")
    parser.add_argument("--loose-threshold", type=int, default=150, help="for gambits and traps")
    parser.add_argument("--only", default="", help="comma-separated opening ids to check")
    args = parser.parse_args()
    only = set(filter(None, args.only.split(",")))

    data = json.loads((ROOT / "data" / "openings.json").read_text())
    engine = chess.engine.SimpleEngine.popen_uci(args.engine)
    engine.configure({"Threads": 4, "Hash": 256})
    limit = chess.engine.Limit(nodes=args.nodes)
    cache = {}
    checked = flagged = 0

    def loss(board, move):
        key = (board.fen(), move.uci())
        if key not in cache:
            color = board.turn
            best = score(engine.analyse(board, limit), color)
            board.push(move)
            after = score(engine.analyse(board, limit), color)
            board.pop()
            cache[key] = (best - after, best, after)
        return cache[key]

    try:
        for opening in data["openings"]:
            if only and opening["id"] not in only:
                continue
            is_loose = bool(LOOSE_STYLES & set(opening["style"]))
            allowed = args.loose_threshold if is_loose else args.threshold
            user_is_white = opening["color"] == "white"
            prefix_length = len(opening["prefix"].split())
            for line in opening["lines"]:
                if line.get("trap"):
                    continue
                board = chess.Board()
                for ply, san in enumerate(line["moves"].split()):
                    move = board.parse_san(san)
                    if ply >= prefix_length and board.turn == user_is_white:
                        lost, best, after = loss(board, move)
                        checked += 1
                        if lost > allowed:
                            flagged += 1
                            number = ply // 2 + 1
                            print(f"{opening['id']} / {line['name']}: {number}{'.' if ply % 2 == 0 else '...'}{san} "
                                  f"loses {lost}cp ({best} -> {after})  [{board.fen()}]", flush=True)
                    board.push(move)
    finally:
        engine.quit()
    print(f"DONE: checked {checked} student moves ({len(cache)} unique), flagged {flagged}", flush=True)


if __name__ == "__main__":
    main()
