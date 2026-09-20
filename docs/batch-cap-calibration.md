# Batch-cap calibration

The reference pass resolves a file's name nodes in batches. One batch is answered by
an array of its own length, so an uncapped batch over a large file makes one answer
proportional to that file, and the pass caps the batch at `ReferenceOptions.batchCap`,
whose default is `DEFAULT_BATCH_CAP`. This page is the measurement that set that
default, and the numbers a reader can check it against.

## What the sweep measured

`scripts/calibrate-batch-cap.ts` opens one compiler client per measurement with the
client's timing collection on, runs the inventory and then the reference pass over
every project a package holds, and reports what the run cost. Each package was
measured at five cap values, `256`, `1024`, `4096`, `16384` and uncapped, five times
each; every number below is the median of the five. Uncapped means one batch per
file, whatever the file's name-node count.

Each row carries seven numbers. **File batches** is one batched lookup per capped run
of a file's name nodes, summed over the package's files. **Round trips** is every
request the client made, the two per-node accessors and the inventory's own lookups
included. **Round-trip latency** and **server time** are the client's own totals, the
second being the time the server spent handling those requests. **Bytes sent** and
**bytes received** are the request and response payloads. **Median wall clock** covers
discovery, the snapshot and both passes.

Nine packages were swept and seven are in the numbers. `@cplieger/deadset-ts` is not:
it holds a project whose sources carry a deliberate type error, and the analysis
refuses a target it cannot type-check. `vibekit-static-src` is not either: it holds a
`export default` of an expression that is not a name, and the compiler's alias
accessor ends the session with an assertion failure on the symbol that declaration
makes.

## The numbers

### @cplieger/actions

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 44           | 764         | 243                     | 219              | 512585     | 3232732        | 293                    |
| `1024`   | 34           | 754         | 254                     | 228              | 511560     | 3232686        | 305                    |
| `4096`   | 34           | 754         | 255                     | 230              | 511560     | 3232737        | 307                    |
| `16384`  | 34           | 754         | 242                     | 218              | 511560     | 3232699        | 294                    |
| uncapped | 34           | 754         | 235                     | 210              | 511560     | 3232711        | 283                    |

### @cplieger/fetch

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 12           | 455         | 126                     | 113              | 164899     | 850175         | 142                    |
| `1024`   | 10           | 453         | 134                     | 120              | 164698     | 850173         | 152                    |
| `4096`   | 10           | 453         | 117                     | 106              | 164698     | 850173         | 131                    |
| `16384`  | 10           | 453         | 135                     | 119              | 164698     | 850173         | 153                    |
| uncapped | 10           | 453         | 136                     | 122              | 164698     | 850167         | 155                    |

### @cplieger/reactive

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 82           | 961         | 589                     | 523              | 1370883    | 8004026        | 744                    |
| `1024`   | 46           | 925         | 590                     | 519              | 1367049    | 8003999        | 740                    |
| `4096`   | 43           | 922         | 471                     | 422              | 1366728    | 8004007        | 604                    |
| `16384`  | 43           | 922         | 491                     | 442              | 1366728    | 8003977        | 624                    |
| uncapped | 43           | 922         | 451                     | 404              | 1366728    | 8003990        | 574                    |

### @cplieger/ui-primitives

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 114          | 1364        | 700                     | 624              | 1859896    | 11275325       | 870                    |
| `1024`   | 65           | 1315        | 680                     | 603              | 1854482    | 11275321       | 871                    |
| `4096`   | 60           | 1310        | 614                     | 557              | 1853927    | 11275339       | 782                    |
| `16384`  | 60           | 1310        | 652                     | 586              | 1853927    | 11275299       | 791                    |
| uncapped | 60           | 1310        | 621                     | 567              | 1853927    | 11275325       | 778                    |

### @cplieger/web-terminal-engine

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 249          | 3032        | 1040                    | 912              | 4801218    | 36292054       | 1413                   |
| `1024`   | 138          | 2921        | 1012                    | 885              | 4787862    | 36291929       | 1351                   |
| `4096`   | 126          | 2909        | 1248                    | 1058             | 4786425    | 36291922       | 1694                   |
| `16384`  | 126          | 2909        | 1365                    | 1144             | 4786425    | 36291902       | 1926                   |
| uncapped | 126          | 2909        | 3128                    | 2738             | 4786425    | 36291789       | 4109                   |

### @cplieger/web-terminal-ui

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 322          | 3101        | 2859                    | 2441             | 6222132    | 44787239       | 3806                   |
| `1024`   | 166          | 2945        | 3723                    | 3172             | 6204589    | 44787005       | 4984                   |
| `4096`   | 136          | 2915        | 3345                    | 2870             | 6201219    | 44786975       | 4439                   |
| `16384`  | 134          | 2913        | 2211                    | 1920             | 6200993    | 44787051       | 2970                   |
| uncapped | 134          | 2913        | 2021                    | 1723             | 6200993    | 44787037       | 2764                   |

### web-terminal-kiro-static-src

| Cap      | File batches | Round trips | Round-trip latency (ms) | Server time (ms) | Bytes sent | Bytes received | Median wall clock (ms) |
| -------- | ------------ | ----------- | ----------------------- | ---------------- | ---------- | -------------- | ---------------------- |
| `256`    | 14           | 768         | 1064                    | 1021             | 309523     | 1229370        | 1102                   |
| `1024`   | 10           | 764         | 1233                    | 1179             | 309019     | 1229410        | 1268                   |
| `4096`   | 9            | 763         | 979                     | 945              | 308893     | 1229398        | 1014                   |
| `16384`  | 9            | 763         | 950                     | 910              | 308893     | 1229409        | 985                    |
| uncapped | 9            | 763         | 968                     | 925              | 308893     | 1229374        | 994                    |

## The bound on a run's round trips

Three terms bound the round trips a run makes: the file batches, one per capped run of
a file's name nodes; the residue fallbacks, one per name node a batch left unresolved;
and the pair assignability calls, one declared-type read per interface of the
conversion set plus one assignability check per class-and-interface pair in it. The
third is zero in every row below, because the calls are made by the
interface-satisfaction pass, which this version does not run.

| Package                       | File batches at `4096` | Residue fallbacks | Pair assignability calls |
| ----------------------------- | ---------------------- | ----------------- | ------------------------ |
| @cplieger/actions             | 34                     | 0                 | 0                        |
| @cplieger/fetch               | 10                     | 0                 | 0                        |
| @cplieger/reactive            | 43                     | 0                 | 0                        |
| @cplieger/ui-primitives       | 60                     | 4                 | 0                        |
| @cplieger/web-terminal-engine | 126                    | 9                 | 0                        |
| @cplieger/web-terminal-ui     | 136                    | 0                 | 0                        |
| web-terminal-kiro-static-src  | 9                      | 0                 | 0                        |

## The default the numbers chose

`DEFAULT_BATCH_CAP` is 4096.

The cap changes the round-trip count and nothing else. Between `256` and uncapped the
bytes a run transfers move by less than one part in two thousand on every package, and
the largest package reads 44,787,239 bytes at `256` against 44,787,037 uncapped: the
answers are the same answers, split into a different number of messages. What the cap
does move is the count of those messages, and that count reaches its floor at `4096`.
Every package makes the same number of round trips at `4096`, at `16384` and uncapped
to within two requests, while `256` costs 6 per cent more on the largest package and
`1024` one per cent more. Above `4096` there is nothing left to win: no file in the
sweep holds more than 16384 name nodes, so `16384` is already one batch per file
everywhere.

The wall clock does not rank the caps and is not what chose the default. Its spread
across the five repeats of one row reaches 114 per cent, and two independent runs of
the whole sweep reproduced every round-trip count, byte total and file-batch count
exactly while their wall-clock medians differed by between 0.59 and 2.34 times. A
difference of two round trips in 2913 is far below that noise, so the wall clock can
neither confirm nor refuse a cap in this range.

So `4096` stays, and it stays for the reason the cap exists. The cap bounds the size of
one answer, and the measurement says that bound costs at most two extra round trips out
of about 2900 on the largest package here: two of its files hold more than 4096 name
nodes, and each of those costs one extra batch. Dropping the cap to buy those two
requests back would let one answer grow with the largest file in the tree, which is the
cost the cap exists to refuse. A lower cap is measurably worse, and a higher one buys
nothing this sweep can see.

## Regenerating this page

The numbers come from one run of the harness, and the document it wrote is committed
beside this page as `batch-cap-calibration.json`. It holds every sample, not only the
medians, and the tables above are its medians:

```sh
node scripts/calibrate-batch-cap.ts \
  --target ../actions --target ../fetch --target ../reactive \
  --caps 256,1024,4096,16384,uncapped --repeat 5 --chosen-default 4096 \
  > docs/batch-cap-calibration.json
npx prettier --write docs/batch-cap-calibration.json
```

`--target` is repeatable and names one package root each. `--chosen-default` is the cap
the record reports as chosen, and a test refuses a record whose chosen default is not
`DEFAULT_BATCH_CAP`, so the two cannot drift apart.
