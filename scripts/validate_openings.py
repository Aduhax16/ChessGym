#!/usr/bin/env python3
"""Check data/openings.json: legal moves, correct prefixes, consistent answers.

    pip install chess
    python scripts/validate_openings.py

Exits with status 1 if anything is wrong, so CI can reject a broken repertoire.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = {"id", "name", "color", "difficulty", "style", "prefix", "summary", "lines"}
DIFFICULTIES = {"Easy", "Medium", "Hard"}
STYLES = {"Aggressive", "Solid", "Gambit", "Tricky", "Positional"}


def key_of(board):
    return " ".join(board.fen().split(" ")[:3])


def validate(data):
    errors = []
    warnings = []
    first_moves = {move["san"] for move in data["firstMoves"]}
    ids = set()

    for opening in data["openings"]:
        label = opening.get("id", "?")
        missing = REQUIRED - opening.keys()
        if missing:
            errors.append(f"{label}: missing fields {sorted(missing)}")
            continue
        if label in ids:
            errors.append(f"{label}: duplicate id")
        ids.add(label)

        prefix = opening["prefix"].split()
        if prefix[0] not in first_moves:
            errors.append(f"{label}: first move {prefix[0]} is not listed in firstMoves")
        if opening["difficulty"] not in DIFFICULTIES:
            errors.append(f"{label}: unknown difficulty {opening['difficulty']}")
        if not set(opening["style"]) <= STYLES:
            errors.append(f"{label}: unknown style {opening['style']}")

        answers = defaultdict(set)
        for line in opening["lines"]:
            moves = line["moves"].split()
            if moves[: len(prefix)] != prefix:
                errors.append(f"{label} / {line['name']}: does not start with the prefix")
            board = chess.Board()
            for ply, san in enumerate(moves):
                try:
                    canonical = board.san(board.parse_san(san))
                except ValueError:
                    errors.append(f"{label} / {line['name']}: illegal {san!r} at ply {ply + 1}")
                    break
                if canonical != san:
                    errors.append(f"{label} / {line['name']}: write {canonical!r}, not {san!r}")
                mover_is_user = board.turn == (opening["color"] == "white")
                if mover_is_user:
                    answers[key_of(board)].add(san)
                board.push_san(san)

        for key, moves in answers.items():
            if len(moves) > 1:
                warnings.append(f"{label}: several answers in {key}: {sorted(moves)}")

    return errors, warnings


def main():
    data = json.loads((ROOT / "data" / "openings.json").read_text())
    errors, warnings = validate(data)
    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    lines = sum(len(opening["lines"]) for opening in data["openings"])
    print(f"{len(data['openings'])} openings, {lines} lines: "
          f"{len(errors)} errors, {len(warnings)} warnings")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
