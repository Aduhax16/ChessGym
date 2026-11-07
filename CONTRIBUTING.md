# Contributing to ChessGym

The most useful contribution needs no JavaScript: **add or improve an opening.**

## Add an opening

Everything lives in [`data/openings.json`](data/openings.json):

```json
{
  "id": "caro-kann",
  "name": "Caro-Kann Defence",
  "color": "black",
  "difficulty": "Easy",
  "style": ["Solid"],
  "prefix": "e4 c6",
  "summary": "One or two sentences that make someone want to play it.",
  "lines": [
    {
      "name": "Advance",
      "moves": "e4 c6 d4 d5 e5 Bf5",
      "idea": "The plan someone should remember after playing this line."
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `color` | The side the student plays. |
| `difficulty` | `Easy`, `Medium` or `Hard`. |
| `style` | Any of `Aggressive`, `Solid`, `Gambit`, `Tricky`, `Positional`. |
| `prefix` | Moves that are forced to reach the opening. After them, the opponent plays from real game data. |
| `moves` | English algebraic notation, separated by spaces, no move numbers. Each line starts with the `prefix`. |

Cover the opponent's most common replies. Anything you leave out still works: the app falls back to what strong players chose in that position.

## Check your lines

```bash
pip install chess && python scripts/validate_openings.py
```

Errors (illegal moves, wrong notation) block the pull request. Warnings mean a position has two different answers, and both will be accepted, so check that is what you meant.

If you have [Stockfish](https://stockfishchess.org/download/), audit the moves too:

```bash
python scripts/check_lines.py --engine /path/to/stockfish
```

It lists any move that loses too much. Gambits and tricky openings get more room. A line that is deliberately unsound needs `"trap": true`, and its `idea` has to tell the student it's a trap.

## Change the code

There is no build step. Serve the folder and reload:

```bash
python3 -m http.server 8000
```

If you touch `js/trainer.js`, `js/bot.js`, `js/rating.js`, `js/book.js` or `js/progress.js`, open <http://localhost:8000/tests/> and make sure everything still passes.

## Regenerate the game data

```bash
pip install chess && python scripts/build_book.py --megabytes 1000
```

This streams part of a monthly [Lichess database](https://database.lichess.org/) dump and needs `curl` and `zstd`. Nothing but the resulting JSON is written to disk.
