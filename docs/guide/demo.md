# The demo

The steps of the live demo and its offline fallback. Back to the
[README](../../README.md).

For the demo, set `FACTORY_BRAIN_GATEWAY=1` (the brain on Claude through
the JigJoy gateway) and, to show the brain's loop live, the Mozaik Cloud
opt-in `FACTORY_MOZAIK_CLOUD=1`; both are described under
[Configuration](configuration.md).

1. `bun run factory doctor`: every line passes, and the brain line names
   the provider and model that answered.
2. Start the APB dashboard in a second terminal (`apb dashboard`) and open
   it in a browser.
3. `bun run factory run examples/specs/demo-units.md --out <dir>`: two
   independent commands, so two executor runs overlap on the dashboard and
   in the trace; the run finishes in under 10 minutes.
4. `bun run factory report <runId>`: tasks, attempts, models, timings and
   cost.
5. The authoring result: `runs/<runId>/authoring-report.md` of a
   `factory author` run (see [Running the factory](running.md#factory-author)).
6. Offline fallback: `examples/replay/demo-units/` holds the plain log
   (`run.log`), the trace and the report of a recorded passing run of the
   same spec.
