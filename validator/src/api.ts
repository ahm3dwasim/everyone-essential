/**
 * The public surface, in one place.
 *
 * This is the entry point the portability check bundles: everything reachable
 * from here must run in a plain JavaScript host with no Node built-ins, so
 * `cli.ts` (which touches `process`) and `bench.ts` (a measurement harness) are
 * deliberately not part of it.
 */
export {
  type Action,
  type ActionEvent,
  type ActionId,
  type Capability,
  type CapabilityChangeEvent,
  type HistoryEvent,
  type Primitive,
  type Puzzle,
  type Role,
  type RoleId,
  type State,
  type TokenId,
  NO_ROLE,
  cloneAction,
  clonePuzzle,
  doneActionIds,
  emptyState,
  isActionEvent,
  isCapabilityChangeEvent,
  normalizeState,
  puzzleKey,
  removeRole,
  replaceActions,
  roleHas,
  sameSet,
  sortedUnique,
  withRoleCapabilities,
} from "./model";
export { canonicalStringify, stableHash } from "./hash";
export { type PlanStep, type SolveOptions, type SolveResult, applyPlan, solve } from "./solve";
export {
  type AccessibilityViolation,
  type Certificate,
  type CertifyOptions,
  type CertifyResult,
  type MeaningfulnessProof,
  type NecessityProof,
  type SolvabilityProof,
  SCAN_MAX_OPTIONS,
  certify,
  checkAccessibility,
  explainFailure,
  isCertificate,
  refusalIssues,
  totalStates,
} from "./certify";
export {
  type ValidationError,
  type ValidationIssue,
  type ValidationResult,
  KNOWN_CAPABILITIES,
  RESERVED_PREFIX,
  describeIssues,
  isReservedId,
  validatePuzzle,
  validateState,
  validationError,
} from "./validate";
export {
  type DiffEntry,
  type OperatorAttempt,
  type OperatorName,
  type RecompileExhausted,
  type RecompileFail,
  type RecompileInvalidInput,
  type RecompileOk,
  type RecompileOperatorError,
  type RecompileOptions,
  type RecompileResult,
  convertAction,
  handOffToken,
  recompile,
} from "./recompile";
export {
  type DemoRun,
  type ProgressCheck,
  DEMO_CHANGE_CAPABILITIES,
  DEMO_CHANGE_ROLE,
  DEMO_PRIMITIVES,
  ROLE_A,
  ROLE_B,
  ROLE_C,
  checkProgressPreserved,
  demoPuzzle,
  runDemo,
} from "./demo";
