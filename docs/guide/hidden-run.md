# The hidden run

How to run the factory on several hidden specs at once against a fixed
cutoff, and what it leaves behind. Back to the [README](../../README.md).

```bash
bun run hidden <spec-a>.md <spec-b>.md --cutoff 19:15 --hard-deadline 19:22 --report-by 19:26
```

One `factory run` per spec, all at once, each delivering into
`hidden/<spec name>/` with `--deliver-unverified`. Options (times are
`HH:MM` local or ISO 8601):

| Option | Effect |
| --- | --- |
| `--cutoff` | Default 19:15, passed to the factory |
| `--hard-deadline` | Default 19:22: a factory still running gets SIGTERM, its process group SIGKILL 30 s later |
| `--report-by` | Default 19:26: the steps after the runs end by then |
| `--task-concurrency` | Default 2 |
| `--replace` | A non-empty `hidden/<spec name>/` is refused unless this is given and the directory holds the factory's delivery marker (`.factory-delivery`); then it is removed before the run |

Each delivery then gets a `.gitignore` of `node_modules/`, is built in a
copy with the built files put back, and its committable files are started
under Node alone. The script prints one row per spec and the owner's steps;
it never changes git state. The first Ctrl-C sends the factories to their
cutoff path, a second kills everything.

## Reports and traces in `hidden/`

Every factory run writes its trace and its report with the time and cost of
every task under `runs/<runId>/` (see [Running the factory](running.md)).
The hidden run also copies each run's report and trace into `hidden/`, so
they are committed next to the deliveries:

1. `hidden/REPORT.md`: one table of all the specs of the hidden run.
2. `hidden/factory-trace/<spec name>/report.md` and `trace.jsonl`: the
   report and the trace of that spec's run.

Human interventions during a run are recorded with
`bun run factory intervene <runId> "<note>"` and show up in that run's
trace and report.
