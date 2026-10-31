# Shared helpers of the build-task scripts. POSIX sh.

# The value of run param $1 from the run's run.yaml, empty when unset.
param() {
  bun -e '
    const file = `${process.env.APB_RUN_DIR}/run.yaml`;
    let run;
    try { run = Bun.YAML.parse(await Bun.file(file).text()); }
    catch { console.error(`build-task: cannot read the run params at ${file}`); process.exit(2); }
    const raw = run?.params?.[process.argv[1]];
    console.log(raw === undefined || raw === null ? "" : String(raw));
  ' "$1"
}
