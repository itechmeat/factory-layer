# Factory run box-office-180409-20261031t170409z-2f17

## Run
- Outcome: partial
- Wall time: 14m 46s (2026-10-31T17:04:09.962Z -> 2026-10-31T17:18:56.456Z)
- Reason: acceptance_unavailable

## Tasks
| Task | Final state | Attempts | Wall time | Models | Tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| scaffold | integrated | 1 | 1m 53s | claude/claude-sonnet-5-5 (actual), jigjoy/claude-sonnet-4-6 (actual) | 36 in / 5061 out / 305660 cache read / 33647 cache write | $0.217184 (reported 4, computed 1) |
| users | integrated | 1 | 51s | claude/claude-sonnet-5-5 (actual), jigjoy/claude-sonnet-4-6 (actual) | 19 in / 4823 out / 151937 cache read / 20825 cache write | $0.148349 (reported 2, computed 2) |
| events | integrated | 1 | 1m 50s | claude/claude-sonnet-5-5 (actual), jigjoy/claude-sonnet-4-6 (actual) | 31 in / 15254 out / 369670 cache read / 44799 cache write | $0.370193 (reported 2, computed 2) |
| orders | integrated | 1 | 2m 42s | claude/claude-sonnet-5-5 (actual), jigjoy/claude-sonnet-4-6 (actual) | 38 in / 23758 out / 590505 cache read / 62604 cache write | $0.546891 (reported 2, computed 1) |
| server | integrated | 1 | 2m 40s | claude/claude-sonnet-5-5 (actual), jigjoy/claude-sonnet-4-6 (actual) | 27 in / 15334 out / 358723 cache read / 54828 cache write | $0.410085 (reported 2, computed 2) |

## Totals
- Tokens: 3986 in / 115978 out / 1805324 cache read / 222515 cache write (+4 unavailable parts)
- Cost: $2.462324 (reported 12, computed 15) (+4 unavailable cost parts)

## Executor usage
- scaffold, attempt 1, node build: claude/claude-sonnet-5-5 (actual), 8 in / 1642 out / 71699 cache read / 9994 cache write, $0.063582 (reported)
- scaffold, attempt 1, node review: claude/claude-sonnet-5-5 (actual), 8 in / 1007 out / 71406 cache read / 7003 cache write, $0.045239 (reported)
- scaffold, attempt 1, node fix: claude/claude-sonnet-5-5 (actual), 10 in / 1040 out / 91277 cache read / 7146 cache write, $0.048132 (reported)
- scaffold, attempt 2, node review: claude/claude-sonnet-5-5 (actual), 8 in / 981 out / 71278 cache read / 7067 cache write, $0.045222 (reported)
- users, attempt 1, node build: claude/claude-sonnet-5-5 (actual), 8 in / 3571 out / 74992 cache read / 9723 cache write, $0.082117 (reported)
- users, attempt 1, node review: claude/claude-sonnet-5-5 (actual), 8 in / 902 out / 74717 cache read / 8658 cache write, $0.05114 (reported)
- events, attempt 1, node build: claude/claude-sonnet-5-5 (actual), 20 in / 14167 out / 275505 cache read / 25032 cache write, $0.269388 (reported)
- events, attempt 1, node review: claude/claude-sonnet-5-5 (actual), 8 in / 767 out / 91678 cache read / 17077 cache write, $0.085162 (reported)
- orders, attempt 1, node build: claude/claude-sonnet-5-5 (actual), 26 in / 22263 out / 489714 cache read / 43167 cache write, $0.444321 (reported)
- orders, attempt 1, node review: claude/claude-sonnet-5-5 (actual), 10 in / 1406 out / 100791 cache read / 16722 cache write, $0.091047 (reported)
- server, attempt 1, node build: claude/claude-sonnet-5-5 (actual), 16 in / 14042 out / 262494 cache read / 33665 cache write, $0.301361 (reported)
- server, attempt 1, node review: claude/claude-sonnet-5-5 (actual), 8 in / 957 out / 93672 cache read / 18431 cache write, $0.092677 (reported)

## Brain usage per decision kind
- plan: 3826 in / 2596 out / 0 cache read / 0 cache write (+1 unavailable part), cost $0.001872 (computed) (+1 unavailable cost part)
- acceptance: 9 in / 49152 out / 28829 cache read / 5812 cache write (+3 unavailable parts), cost $0.767751 (computed) (+3 unavailable cost parts)
- judge: 13 in / 1485 out / 7272 cache read / 13018 cache write, cost $0.073313 (computed)

## Decision intervals
- acceptance: 2026-10-31T17:04:10.443Z -> 2026-10-31T17:08:40.451Z
- plan: 2026-10-31T17:04:10.447Z -> 2026-10-31T17:06:48.415Z
- judge@scaffold: 2026-10-31T17:10:27.106Z -> 2026-10-31T17:10:30.877Z
- judge@users: 2026-10-31T17:11:18.649Z -> 2026-10-31T17:11:22.793Z
- judge@events: 2026-10-31T17:13:09.200Z -> 2026-10-31T17:13:13.312Z
- judge@orders: 2026-10-31T17:15:54.145Z -> 2026-10-31T17:15:55.940Z
- judge@server: 2026-10-31T17:18:21.470Z -> 2026-10-31T17:18:25.932Z
Overlapping pairs:
- acceptance overlaps plan

## Recoveries
No recoveries were recorded.

## Failed checks
No failed checks were recorded.

## Intervention log
No human intervention was recorded.
