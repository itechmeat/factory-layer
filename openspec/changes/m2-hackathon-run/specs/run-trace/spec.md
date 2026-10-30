# Spec Delta

## ADDED Requirements

### Requirement: Executor run overlap in the report

The report SHALL list each executor run interval (task, attempt, executor
run id, start, end; a run without an end event ends at the run end) and the
pairs of executor runs that overlapped in time, or state that none did.

#### Scenario: Two task runs overlap

- **WHEN** executor runs of tasks `a` and `b` run from t1 to t3 and from t2 to t4 with t2 before t3
- **THEN** the report lists both intervals and the pair `a` and `b` as overlapping
