# Offline latency comparison

This is a controlled local replay, **not production or live-provider latency**.
Timing policy is scaled 1:100 (55 seconds becomes 550 ms); each result is the median of three runs.
The unchanged baseline is main commit `2d715a0cc989acd9d46ee3a5a4dd262132e6f865`.
Both versions use identical fake provider delays, signed fixture identities and fake rate limiters.

| Scenario           | Version | HTTP | TTFB (ms) | Total (ms) | Stream handoff to EOF (ms) | Cloudflare calls/run |
| ------------------ | ------- | ---: | --------: | ---------: | -------------------------: | -------------------- |
| healthy-stream     | before  |  200 |    24.035 |     62.737 |                     39.508 | [0, 0, 0]            |
| healthy-stream     | after   |  200 |    26.145 |     65.157 |                     39.505 | [0, 0, 0]            |
| exhausted-fallback | before  |  200 |   640.258 |    640.261 |                      0.093 | [1, 1, 1]            |
| exhausted-fallback | after   |  504 |   552.158 |    552.163 |                      0.169 | [0, 0, 0]            |

The failure replay demonstrates bounded waiting, not faster model generation: the original Worker
starts Cloudflare AI after Groq has consumed the remaining deadline; the fixed Worker returns a
controlled 504 and starts no late fallback. Healthy streaming remains functionally unchanged.
Do not extrapolate these scaled timings into production latency improvements. A real before/after
comparison still requires an explicitly approved deployment/canary and comparable traffic.

Reproduce with Node 22: `node tests/latency-benchmark.mjs /path/to/baseline-worktree`.
No deployment, provider API call, secret change or billing action is performed by this benchmark.
