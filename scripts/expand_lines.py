#!/usr/bin/env python3
"""Add lines to each opening of the repertoire, from real games and Stockfish.

    pip install chess
    python scripts/expand_lines.py --engine /path/to/stockfish --names /path/to/chess-openings

`--names` is a folder with a.tsv … e.tsv from github.com/lichess-org/chess-openings (CC0),
used to name the new lines.

From the end of an opening's prefix it grows a tree:
- the opponent's moves are the replies people really play (common among 2000+ players
  or at club level), skipping any that Stockfish rates as a clear mistake;
- your moves are the ones already in the opening's lines when the position is known,
  otherwise the most popular move among 2000+ players that Stockfish rates close to
  its best, or Stockfish's own choice when strong players have no data there.
The most likely branches that the existing lines don't cover become new lines, until
the opening has --target lines. Existing lines are never changed.
"""
import argparse
import json
import multiprocessing
from pathlib import Path

import chess
import chess.engine

import repertoire

ROOT = Path(__file__).resolve().parent.parent
BOOK = ROOT / "data" / "book"
CLUB_BANDS = ["1000", "1250", "1500", "1750"]
MATE = 3000

# The opponent's replies worth a line: common enough and not a clear mistake.
REFERENCE_SHARE = 0.05
CLUB_SHARE = 0.07
RIVAL_MAX_LOSS = 70
# Branches the opponent reaches less often than this are cut, so the tree stays finite.
MIN_PROBABILITY = 0.0003
# Your move: the most popular among strong players within this much of the best.
USER_MAX_LOSS = 35
# Once real games run out, a second engine move is also followed if it is this close to the best.
ENGINE_ALTERNATIVE = 25
MAX_PLIES = 20
MULTIPV = 8


def key_of(board):
    return " ".join(board.fen().split(" ")[:3])


def load_books():
    reference = json.loads((BOOK / "reference.json").read_text())
    club = {}
    for band in CLUB_BANDS:
        for key, rows in json.loads((BOOK / f"{band}.json").read_text()).items():
            merged = club.setdefault(key, {})
            for san, games, *_ in rows:
                merged[san] = merged.get(san, 0) + games
    return reference, club


def shares(rows):
    total = sum(rows.values())
    return {san: games / total for san, games in rows.items()} if total else {}


def load_names(folder):
    names = {}
    for letter in "abcde":
        for row in (Path(folder) / f"{letter}.tsv").read_text().splitlines()[1:]:
            eco, name, pgn = row.split("\t")
            board = chess.Board()
            for token in pgn.split():
                if token[0].isdigit():
                    continue
                board.push_san(token)
            names[key_of(board)] = name
    return names


class Worker:
    def __init__(self, engine_path, nodes):
        self.engine = chess.engine.SimpleEngine.popen_uci(engine_path)
        self.engine.configure({"Threads": 1, "Hash": 64})
        self.limit = chess.engine.Limit(nodes=nodes)
        self.cache = {}

    def scores(self, board):
        """Stockfish's best moves in this position, as {san: centipawns for the side to move}."""
        key = board.fen()
        if key not in self.cache:
            infos = self.engine.analyse(board, self.limit, multipv=MULTIPV)
            result = {}
            for info in infos:
                if "pv" not in info:
                    continue
                result[board.san(info["pv"][0])] = info["score"].pov(board.turn).score(mate_score=MATE)
            self.cache[key] = result
        return self.cache[key]

    def close(self):
        self.engine.quit()


def answers_of(opening):
    """Your move in each position of the existing lines (the first one written wins)."""
    user_white = opening["color"] == "white"
    answers = {}
    for line in opening["lines"]:
        board = chess.Board()
        for san in line["moves"].split():
            if board.turn == user_white:
                answers.setdefault(key_of(board), san)
            board.push_san(san)
    return answers


def grow(opening, books, worker):
    """Every branch from the end of the prefix, with how likely the opponent is to go there."""
    reference, club = books
    user_white = opening["color"] == "white"
    answers = answers_of(opening)
    prefix = opening["prefix"].split()
    max_plies = max(MAX_PLIES, len(prefix) + 10)
    leaves = []

    def user_move(board):
        key = key_of(board)
        if key in answers:
            return answers[key]
        engine = worker.scores(board)
        if not engine:
            return None
        best = max(engine.values())
        popular = sorted(shares(dict((r[0], r[1]) for r in reference.get(key, []))).items(), key=lambda item: -item[1])
        for san, _share in popular:
            if san in engine and best - engine[san] <= USER_MAX_LOSS:
                return san
        return max(engine, key=engine.get)

    def rival_moves(board):
        key = key_of(board)
        strong = shares(dict((r[0], r[1]) for r in reference.get(key, [])))
        common = shares(club.get(key, {}))
        candidates = {san: max(strong.get(san, 0), common.get(san, 0)) for san in set(strong) | set(common)
                      if strong.get(san, 0) >= REFERENCE_SHARE or common.get(san, 0) >= CLUB_SHARE}
        if not candidates:
            return []
        engine = worker.scores(board)
        best = max(engine.values()) if engine else 0
        legal = {board.san(move) for move in board.legal_moves}
        kept = []
        for san, share in candidates.items():
            if san not in legal:
                continue
            # A popular move outside Stockfish's top choices is kept only if it is very popular.
            if san in engine:
                if best - engine[san] > RIVAL_MAX_LOSS:
                    continue
            elif share < 0.3:
                continue
            kept.append((san, share, common.get(san, 0), strong.get(san, 0)))
        return sorted(kept, key=lambda item: -item[1])

    def walk(board, moves, probability, notes):
        # A position seen twice means pieces going back and forth: the line ends there.
        if board.is_game_over() or len(moves) >= max_plies or board.is_repetition(2):
            leaves.append((moves, probability, notes))
            return
        if board.turn == user_white:
            san = user_move(board)
            if san is None:
                leaves.append((moves, probability, notes))
                return
            board.push_san(san)
            walk(board, moves + [san], probability, notes)
            board.pop()
            return
        replies = rival_moves(board)
        if not replies:
            # Past the real games, the opponent's best moves by Stockfish carry the line on.
            engine = worker.scores(board)
            if not engine:
                leaves.append((moves, probability, notes))
                return
            best = max(engine.values())
            good = sorted((san for san in engine if best - engine[san] <= ENGINE_ALTERNATIVE), key=lambda san: -engine[san])
            replies = [(san, 1 / len(good[:2]), 0, 0) for san in good[:2]]
        likely = [reply for reply in replies if probability * reply[1] >= MIN_PROBABILITY]
        replies = likely or replies[:1]
        for san, share, club_share, strong_share in replies:
            board.push_san(san)
            note = (len(moves), san, club_share, strong_share)
            walk(board, moves + [san], probability * share, notes + [note])
            board.pop()

    board = chess.Board()
    for san in prefix:
        board.push_san(san)
    walk(board, list(prefix), 1.0, [])
    return leaves


def move_label(ply, san):
    number = ply // 2 + 1
    return f"{number}.{san}" if ply % 2 == 0 else f"{number}...{san}"


def short_name(name, opening_name):
    """The part of a Lichess opening name that says more than the opening's own name."""
    family, _, variation = name.partition(": ")
    if not variation:
        return None
    if opening_name.lower().startswith(name.lower()):
        return None
    return variation


def describe(moves, notes, existing, user_white, names, opening, worker, taken):
    # Where this line leaves the closest line already chosen.
    def shared(other):
        count = 0
        for a, b in zip(moves, other):
            if a != b:
                break
            count += 1
        return count

    split = max((shared(other) for other in existing), default=0)
    deviation = next((note for note in notes if note[0] >= split), notes[-1] if notes else None)

    # A Lichess name is used only if it is reached after this line splits off,
    # so it names this branch rather than the whole opening.
    board = chess.Board()
    named = None
    for ply, san in enumerate(moves):
        board.push_san(san)
        if key_of(board) in names and ply >= split:
            named = names[key_of(board)]
    variation = short_name(named, opening["name"]) if named else None
    if variation:
        variation = variation.split(", ")[-1]

    if deviation:
        ply, san, club_share, strong_share = deviation
        label = move_label(ply, san)
        reply = moves[ply + 1] if ply + 1 < len(moves) else None
        if club_share >= strong_share and club_share:
            how = f"chosen in {round(club_share * 100)}% of club games here"
        elif strong_share:
            how = f"chosen by {round(strong_share * 100)}% of 2000+ players here"
        else:
            how = "Stockfish's choice once real games run out"
        idea = f"{label} is {how}."
        if reply:
            idea += f" Your answer is {move_label(ply + 1, reply)}."
    else:
        label = None
        idea = "A common way for this opening to go."

    final = chess.Board()
    for san in moves:
        final.push_san(san)
    engine = worker.scores(final)
    if engine and not final.is_game_over():
        score = max(engine.values())
        for_user = score if final.turn == user_white else -score
        if for_user >= 80:
            idea += " You come out better."
        elif for_user <= -80:
            idea += " Stockfish prefers your opponent's position here, so play accurately."
        else:
            idea += " The position is about equal, with a normal game ahead."

    later = [move_label(note[0], note[1]) for note in notes if deviation and note[0] > deviation[0]]
    options = [variation] if variation else []
    if label:
        options.append(f"Against {label}")
        options += [f"Against {label}, then {other}" for other in later]
    options.append(f"Line {len(taken) + 1}")
    name = next(option for option in options if option not in taken)
    return name, idea


def expand(task):
    opening, engine_path, nodes, target, names = task
    if len(opening["lines"]) >= target:
        return opening["id"], []
    books = load_books()
    worker = Worker(engine_path, nodes)
    try:
        leaves = grow(opening, books, worker)
        existing = [line["moves"].split() for line in opening["lines"]]
        answers = answers_of(opening)

        def covered(moves):
            for other in existing:
                # Same branch: one line is the start of the other.
                if other[: len(moves)] == moves or moves[: len(other)] == other:
                    return True
            return False

        new_lines = []
        taken_names = {line["name"] for line in opening["lines"]}
        user_white = opening["color"] == "white"
        for moves, probability, notes in sorted(leaves, key=lambda leaf: -leaf[1]):
            if len(opening["lines"]) + len(new_lines) >= target:
                break
            # A line ends on your move: a last move by the opponent would teach nothing.
            if (len(moves) % 2 == 1) != user_white:
                moves = moves[:-1]
                notes = [note for note in notes if note[0] < len(moves)]
            if covered(moves) or len(moves) < len(opening["prefix"].split()) + 4:
                continue
            # Through a transposition, a branch could answer a known position differently.
            mine = {}
            board = chess.Board()
            repeats = False
            for san in moves:
                if board.turn == user_white:
                    repeats = repeats or mine.get(key_of(board), san) != san
                    mine.setdefault(key_of(board), san)
                board.push_san(san)
            if repeats or any(answers.get(key, san) != san for key, san in mine.items()):
                continue
            for key, san in mine.items():
                answers.setdefault(key, san)
            name, idea = describe(moves, notes, existing, opening["color"] == "white", names, opening, worker, taken_names)
            taken_names.add(name)
            existing.append(moves)
            new_lines.append({"name": name, "moves": " ".join(moves), "idea": idea, "generated": True})
        return opening["id"], new_lines
    finally:
        worker.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--names", required=True)
    parser.add_argument("--nodes", type=int, default=150_000)
    parser.add_argument("--target", type=int, default=150)
    parser.add_argument("--only", default="", help="comma-separated opening ids")
    parser.add_argument("--workers", type=int, default=max(1, multiprocessing.cpu_count() - 1))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    only = set(filter(None, args.only.split(",")))

    data = repertoire.load()
    names = load_names(args.names)
    tasks = [(opening, args.engine, args.nodes, args.target, names)
             for opening in data["openings"] if not only or opening["id"] in only]
    added = {}
    with multiprocessing.Pool(args.workers) as pool:
        for opening_id, lines in pool.imap_unordered(expand, tasks):
            added[opening_id] = lines
            print(f"{opening_id}: +{len(lines)}", flush=True)
            for line in lines:
                print(f"    {line['name']}: {line['moves']}\n      {line['idea']}", flush=True)

    if args.dry_run:
        return
    for opening in data["openings"]:
        for line in added.get(opening["id"], []):
            line.pop("generated", None)
            opening["lines"].append(line)
    repertoire.save(data)
    total = sum(len(lines) for lines in added.values())
    print(f"Added {total} lines.")


if __name__ == "__main__":
    main()
