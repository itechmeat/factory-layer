# Hackathon scope

Date: 2026-10-30. Status: decided by the owner.

The goal for the hackathon is the brain and APB link working on the hidden
specs, and a live demo. Everything else is deferred. The plan for the
remaining work is the OpenSpec change `m2-hackathon-run`; the product
design (`2026-10-30-factory-layer-design.md`) stays the long-term target.

## Changes to the design

| Item | Reason |
| --- | --- |
| Brain model: Claude through the JigJoy Anthropic gateway when `JIGJOY_ANTHROPIC_BASE_URL` and `JIGJOY_ANTHROPIC_API_KEY` are set, GLM-5.3-Flash on Z.ai as fallback (was GLM-5.3-Flash only) | Hackathon gateway credits, and better acceptance checks and judgements. The `ANTHROPIC_*` names are not used, so Claude Code does not pick them up. |
| The live demo, and possibly the hidden run, on the owner's Mac | That is the demo machine; development stays on Linux. |

## Keep

| Item | Reason |
| --- | --- |
| `factory run --cutoff <HH:MM>` with `--out <dir>` as today, and an active cutoff in the core | The passive cutoff waited for active tasks; at the cutoff live runs must stop and delivery must start. |
| Hidden run as one `factory run` process per spec, in parallel, two task runs each | Two processes need no new orchestration code; a unique spec name gives a fresh work repository; two task runs each keep Claude Code sessions at four. |
| Unverified delivery copied before verification | A run cut off or killed during verification must still leave a package. |
| Delivered build output committable (`!hidden/**`, per-delivery `.gitignore` of `node_modules/`) | The acceptance tests run on what is pushed; ignored `dist/` files would be missing. |
| `bun run hidden <spec.md>...` script with a table and a startup check | One rehearsed command under time pressure; the startup check runs on exactly the committable files. |
| Checks under Node without `bun` on `PATH`, build before tests | The graders may run Node only; a package that only works under Bun must fail here, not there. |
| One HTTP practice spec end to end with a minimal HTTP example check | HTTP APIs are one of the two hidden spec kinds and are not yet proven. |
| One demo spec with two independent commands, also the parallel proof | One rehearsal serves the demo and the concurrency evidence. |
| Executor-run overlap in the report (optional) | A few lines over existing aggregation; dropped first if late. |
| Rebind restricted to the `claude` profile | Only Claude Code is set up for the demo and the hidden run; a rebind to another agent would fail. |
| Minimal `factory author <kind>` with one rehearsed run | Design goal 5 is required: the brain proposes, APB creates, validates, trials, the brain approves. |
| macOS readiness: portability audit of the demo and hidden-run paths, `factory doctor`, one demo run and one hidden-run dry run on the Mac, README "macOS setup" | The demo runs on the Mac; a Linux-only call there would fail live. |
| README "Running the factory" and one demo walkthrough | The live demo and the README are judged. |

## Deferred

| Item | Reason |
| --- | --- |
| Several specs in one process, shared-slot changes | Two processes give the same result for two specs. |
| Concurrency report section beyond the executor overlap | The overlap of decisions and task runs already proves concurrency. |
| Terminal lanes | Plain event lines and the APB dashboard are enough for the demo. |
| `factory replay` and a recorded run | The offline fallback is a recorded plain log plus the reports. |
| `resume`, `stop` and `replace` commands | The cutoff path and a fresh run under a new spec name cover the hidden run. |
| Per-run workspace namespacing | A unique spec name per run gives a fresh work repository without code changes. |
| Provoked-failure drills | Recovery is covered by the core's tests and by real failures in rehearsals. |
| Limit tuning programme | Initial limits stay; one constant may change if a rehearsal shows rate limits. |
| Clean-install rehearsal beyond the README walkthrough | Out of scope; the README is written against this machine's setup. |
| Venue drill beyond one demo walkthrough | One walkthrough on the demo machine is enough. |
| General allowed-profiles policy, profile checks beyond `claude` | Only one agent is used. |
| HTML report | Optional and last: merged only if the external agent's branch lands unchanged and costs no review time. |
| A separate parallel-tasks spec | Merged into the demo spec. |
