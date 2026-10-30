/**
 * Application testing barrel: the fakes of every port plus the deterministic
 * fixture builders. Tests import these; production code never does.
 */

export { FAKE_CLOCK_START_ISO, FakeClock, fakeSleep } from './fake-clock';
export {
  FAKE_BRAIN_MODEL,
  FAKE_BRAIN_PROVIDER,
  FakeBrain,
  type BrainAnswer,
  type BrainCallRecord,
  type DecisionOf,
  type KindScript,
} from './fake-brain';
export {
  FakeExecutor,
  type FakeExecutorCommand,
  type FakeFoundRun,
  type FakeRun,
  type FakeStartScript,
  type FakeStopScript,
} from './fake-executor';
export {
  FakeWorkspace,
  type FakeCommitRecord,
  type FakeDeliveryRecord,
  type FakeHandoverRecord,
  type FakeIntegrationScript,
} from './fake-workspace';
export { FakeCheckRunner, type FakeCheckCall, type FakePackageCall } from './fake-check-runner';
export { FakeStore, type FakeIntervention } from './fake-store';
export { FakeSink } from './fake-sink';
export { FakeMemory, type FakeRecallCall } from './fake-memory';
export { SLOT_POLL_MS, FakeSlots } from './fake-slots';
export { FAKE_DEFAULT_INPUT_USD_PER_MILLION, FAKE_DEFAULT_OUTPUT_USD_PER_MILLION, FakeCostTable } from './fake-cost-table';
export { FakePlaybookAuthoring, type FakePlaybookCall } from './fake-playbook-authoring';
export { anExecutorReport, aPlan, aRunState, aSpec, aTask, aTaskFailure, cliCheck, commandCheck, httpCheck } from './builders';
export { crashingPorts, restartedPorts, type CrashPoint } from './crash';
export { drive } from './drive';
export { fakePorts, type FakePorts } from './fake-ports';
export { planOf, SlotRecordingSink, succeedRuns } from './scenario';
