"""Reads and writes the repertoire.

data/openings.json holds each opening's details and how many lines it has, so the
page loads quickly. The lines themselves live in data/lines/<id>.json and are only
downloaded when someone trains that opening.
"""
import json
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parent.parent
OPENINGS = ROOT / "data" / "openings.json"
LINES = ROOT / "data" / "lines"


def key_of(board):
    return " ".join(board.fen().split(" ")[:3])


def load():
    """openings.json with every opening's `lines` filled in."""
    data = json.loads(OPENINGS.read_text())
    for opening in data["openings"]:
        opening["lines"] = json.loads((LINES / f"{opening['id']}.json").read_text())
    return data


def user_positions(opening):
    """How many positions in the lines ask the user for a move (the mastery bar's total)."""
    user_white = opening["color"] == "white"
    keys = set()
    for line in opening["lines"]:
        board = chess.Board()
        for san in line["moves"].split():
            if board.turn == user_white:
                keys.add(key_of(board))
            board.push_san(san)
    return len(keys)


def _row(value):
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def save(data):
    """Writes data/lines/<id>.json for each opening and the summary in openings.json."""
    LINES.mkdir(exist_ok=True)
    rows = []
    for opening in data["openings"]:
        lines = opening["lines"]
        body = ",\n".join(f"  {_row({key: line[key] for key in ('name', 'moves', 'idea')})}" for line in lines)
        (LINES / f"{opening['id']}.json").write_text(f"[\n{body}\n]\n")
        summary = {key: value for key, value in opening.items() if key != "lines"}
        summary["lineCount"] = len(lines)
        summary["positions"] = user_positions(opening)
        rows.append(f"    {_row(summary)}")
    others = {key: value for key, value in data.items() if key != "openings"}
    def field(key, value):
        if isinstance(value, list):
            return f"  {json.dumps(key)}: [\n" + ",\n".join(f"    {_row(item)}" for item in value) + "\n  ]"
        return f"  {json.dumps(key)}: {_row(value)}"

    head = ",\n".join(field(key, value) for key, value in others.items())
    OPENINGS.write_text("{\n" + head + ',\n  "openings": [\n' + ",\n".join(rows) + "\n  ]\n}\n")
