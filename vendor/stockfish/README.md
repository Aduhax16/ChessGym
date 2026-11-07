# Stockfish in ChessGym

Free play runs [Stockfish](https://github.com/official-stockfish/Stockfish) in the browser, using the [Stockfish.js](https://github.com/nmrugg/stockfish.js) WebAssembly port. This folder is **GPL-3, not MIT** like the rest of the repository. See [Copying.txt](Copying.txt).

## What is here

| File | What it is |
| --- | --- |
| `stockfish-19-lite-single.js`, `stockfish-19-lite-single.wasm` | The engine, unmodified, from the [`stockfish` npm package](https://www.npmjs.com/package/stockfish) version 19.0.1 |
| `stockfish.js-19.0.1-source.tar.gz` | The source for that version: the `v19.0.1` tag of [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js/tree/v19.0.1) |
| `nn-61e7af4bb97d.nnue` | The neural network built into the engine, which the source fetches at build time. From [Fishtest](https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue) |
| `Copying.txt` | The GNU General Public License, version 3 |

SHA-256 of the engine files:

```text
ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a  stockfish-19-lite-single.js
ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de  stockfish-19-lite-single.wasm
```

To rebuild it, unpack the source, put the network in its `src/` folder and run `npm run build-single-lite`. This needs emscripten 6.0.9.

## How it is kept separate from the MIT code

`js/bot.js` starts the unmodified engine as its own Web Worker and exchanges UCI text messages with it. ChessGym doesn't link to it, compile against it or use its internals, and any other UCI engine could take its place. That makes the two separate programs distributed side by side, which section 5 of the GPL-3 calls an "aggregate", so the GPL covers the engine and not ChessGym's own code.

If you change these files, you must say so and publish your changes under the GPL-3 too.
