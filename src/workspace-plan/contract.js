import * as z from 'zod/v4';

export const WORKSPACE_PLAN_SCHEMA_VERSION = 1;
export const WORKSPACE_PLAN_INITIAL_REVISION = 1;
export const WORKSPACE_PLAN_MAX_PHASES = 128;
export const WORKSPACE_PLAN_MAX_INITIAL_PHASES = WORKSPACE_PLAN_MAX_PHASES - 1;
export const WORKSPACE_PLAN_MAX_PHASE_GOAL_LENGTH = 8000;
export const WORKSPACE_PLAN_PHASE_TYPES = Object.freeze([
  'implementation',
  'test',
  'fix_review',
  'review_diff'
]);
export const WORKSPACE_PLAN_PHASE_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed'
]);

export const DEFAULT_REVIEW_DIFF_TITLE = 'Review diff';
export const DEFAULT_REVIEW_DIFF_GOAL =
  'Review only the diff produced for this task against taskGoal, scope, constraints, and acceptanceCriteria; identify regressions, security issues, compatibility problems, scope drift, unnecessary changes, and missing tests before allowing task completion.';
export const FIX_REVIEW_GOAL_PREFIX =
  'Resolve the blocking findings from the previous review_diff before re-running review:';

const shortText = z.string().trim().min(1).max(256);
const longText = z.string().trim().min(1).max(WORKSPACE_PLAN_MAX_PHASE_GOAL_LENGTH);
const textList = z.array(longText).min(1).max(128);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'Expected an ISO-compatible timestamp.'
});

export function buildFixReviewGoal(findings) {
  return [
    FIX_REVIEW_GOAL_PREFIX,
    ...findings.map((finding) => `- ${finding}`)
  ].join('\n');
}

export const workspacePlanDraftPhaseSchema = z.object({
  type: z.enum(WORKSPACE_PLAN_PHASE_TYPES),
  title: shortText,
  goal: longText
}).strict();

export const workspacePlanPhaseSchema = workspacePlanDraftPhaseSchema.extend({
  id: z.number().int().positive(),
  status: z.enum(WORKSPACE_PLAN_PHASE_STATUSES)
}).strict();

function validateDraftPhases(phases, ctx) {
  const reviewIndexes = phases
    .map((phase, index) => phase.type === 'review_diff' ? index : -1)
    .filter((index) => index >= 0);

  if (reviewIndexes.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['phases'],
      message: 'Only one review_diff phase is allowed.'
    });
    return;
  }

  if (reviewIndexes.length === 1 && reviewIndexes[0] !== phases.length - 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['phases', reviewIndexes[0]],
      message: 'review_diff must be the final phase.'
    });
  }

  if (reviewIndexes.length === 0 && phases.length >= WORKSPACE_PLAN_MAX_INITIAL_PHASES) {
    ctx.addIssue({
      code: 'custom',
      path: ['phases'],
      message: `At most ${WORKSPACE_PLAN_MAX_INITIAL_PHASES - 1} phases are allowed when review_diff is omitted so the system can append review_diff and reserve one fix_review slot.`
    });
  }

  if (reviewIndexes.length === 1 && phases.length > WORKSPACE_PLAN_MAX_INITIAL_PHASES) {
    ctx.addIssue({
      code: 'custom',
      path: ['phases'],
      message: `At most ${WORKSPACE_PLAN_MAX_INITIAL_PHASES} phases are allowed in a new plan so one fix_review slot remains available.`
    });
  }
}

export const workspacePlanDraftSchema = z.object({
  title: shortText,
  taskGoal: longText,
  scope: textList,
  constraints: textList,
  acceptanceCriteria: textList,
  phases: z.array(workspacePlanDraftPhaseSchema).min(1).max(WORKSPACE_PLAN_MAX_PHASES)
}).strict().superRefine((draft, ctx) => {
  validateDraftPhases(draft.phases, ctx);
});

export const workspacePlanIntentUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: shortText.optional(),
  taskGoal: longText.optional(),
  scope: textList.optional(),
  constraints: textList.optional(),
  acceptanceCriteria: textList.optional()
}).strict().refine(
  (value) => value.title !== undefined
    || value.taskGoal !== undefined
    || value.scope !== undefined
    || value.constraints !== undefined
    || value.acceptanceCriteria !== undefined,
  { message: 'At least one intent field must be updated.' }
);

export const workspacePlanReviewSchema = z.object({
  passed: z.boolean(),
  findings: z.array(longText).max(128).default([])
}).strict().superRefine((review, ctx) => {
  if (review.passed && review.findings.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: 'A passed review must not contain findings.'
    });
  }
  if (!review.passed && review.findings.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: 'A failed review must contain at least one finding.'
    });
  }
  if (
    !review.passed
    && review.findings.length > 0
    && buildFixReviewGoal(review.findings).length > WORKSPACE_PLAN_MAX_PHASE_GOAL_LENGTH
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['findings'],
      message: `Review findings are too large to persist in a fix_review goal of at most ${WORKSPACE_PLAN_MAX_PHASE_GOAL_LENGTH} characters.`
    });
  }
});

export const workspacePlanCompletePhaseSchema = z.object({
  expectedRevision: z.number().int().positive(),
  phaseId: z.number().int().positive(),
  review: workspacePlanReviewSchema.optional()
}).strict();

export const workspacePlanClearSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: longText.optional()
}).strict();

export const workspacePlanSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_PLAN_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  taskId: z.string().trim().min(1).max(160),
  title: shortText,
  status: z.literal('active'),
  taskGoal: longText,
  scope: textList,
  constraints: textList,
  acceptanceCriteria: textList,
  currentPhase: z.number().int().positive(),
  phases: z.array(workspacePlanPhaseSchema).min(1).max(WORKSPACE_PLAN_MAX_PHASES),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine((plan, ctx) => {
  const ids = new Set();
  let reviewCount = 0;
  let currentIndex = -1;

  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index];
    if (ids.has(phase.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['phases', index, 'id'],
        message: `Duplicate phase id: ${phase.id}`
      });
    }
    ids.add(phase.id);
    if (phase.type === 'review_diff') reviewCount += 1;
    if (phase.id === plan.currentPhase) currentIndex = index;
  }

  if (reviewCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['phases'],
      message: 'Exactly one review_diff phase is required.'
    });
  }

  const finalPhase = plan.phases.at(-1);
  if (finalPhase?.type !== 'review_diff') {
    ctx.addIssue({
      code: 'custom',
      path: ['phases'],
      message: 'The final phase must be review_diff.'
    });
  } else {
    if (finalPhase.title !== DEFAULT_REVIEW_DIFF_TITLE) {
      ctx.addIssue({
        code: 'custom',
        path: ['phases', plan.phases.length - 1, 'title'],
        message: 'review_diff title must use the canonical system title.'
      });
    }
    if (finalPhase.goal !== DEFAULT_REVIEW_DIFF_GOAL) {
      ctx.addIssue({
        code: 'custom',
        path: ['phases', plan.phases.length - 1, 'goal'],
        message: 'review_diff goal must use the canonical system goal.'
      });
    }
  }

  if (currentIndex < 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['currentPhase'],
      message: 'currentPhase must reference an existing phase id.'
    });
    return;
  }

  for (let index = 0; index < plan.phases.length; index += 1) {
    const phase = plan.phases[index];
    const expected = index < currentIndex
      ? 'completed'
      : index === currentIndex
        ? 'in_progress'
        : 'pending';
    if (phase.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['phases', index, 'status'],
        message: `Expected status ${expected} for phase ${phase.id} while currentPhase is ${plan.currentPhase}.`
      });
    }
  }
});

export function ensureFinalReviewDiff(phases) {
  const parsed = z.array(workspacePlanDraftPhaseSchema).min(1).max(WORKSPACE_PLAN_MAX_PHASES).parse(phases);
  const reviewIndexes = parsed
    .map((phase, index) => phase.type === 'review_diff' ? index : -1)
    .filter((index) => index >= 0);

  if (reviewIndexes.length > 1) {
    throw new Error('Only one review_diff phase is allowed.');
  }
  if (reviewIndexes.length === 1 && reviewIndexes[0] !== parsed.length - 1) {
    throw new Error('review_diff must be the final phase.');
  }
  if (reviewIndexes.length === 0 && parsed.length >= WORKSPACE_PLAN_MAX_INITIAL_PHASES) {
    throw new Error(`At most ${WORKSPACE_PLAN_MAX_INITIAL_PHASES - 1} phases are allowed when review_diff is omitted.`);
  }
  if (reviewIndexes.length === 1 && parsed.length > WORKSPACE_PLAN_MAX_INITIAL_PHASES) {
    throw new Error(`At most ${WORKSPACE_PLAN_MAX_INITIAL_PHASES} phases are allowed in a new plan.`);
  }
  if (reviewIndexes.length === 1) {
    return parsed.map((phase, index) => index === parsed.length - 1
      ? { type: 'review_diff', title: DEFAULT_REVIEW_DIFF_TITLE, goal: DEFAULT_REVIEW_DIFF_GOAL }
      : { ...phase });
  }

  return [
    ...parsed.map((phase) => ({ ...phase })),
    {
      type: 'review_diff',
      title: DEFAULT_REVIEW_DIFF_TITLE,
      goal: DEFAULT_REVIEW_DIFF_GOAL
    }
  ];
}

export function buildWorkspacePlanDocument(draft, {
  taskId,
  now = new Date().toISOString()
} = {}) {
  const parsed = workspacePlanDraftSchema.parse(draft);
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new TypeError('taskId is required.');
  }

  const phases = ensureFinalReviewDiff(parsed.phases).map((phase, index) => ({
    id: index + 1,
    ...phase,
    status: index === 0 ? 'in_progress' : 'pending'
  }));

  return workspacePlanSchema.parse({
    schemaVersion: WORKSPACE_PLAN_SCHEMA_VERSION,
    revision: WORKSPACE_PLAN_INITIAL_REVISION,
    taskId: taskId.trim(),
    title: parsed.title,
    status: 'active',
    taskGoal: parsed.taskGoal,
    scope: parsed.scope,
    constraints: parsed.constraints,
    acceptanceCriteria: parsed.acceptanceCriteria,
    currentPhase: phases[0].id,
    phases,
    createdAt: now,
    updatedAt: now
  });
}

export function parseWorkspacePlan(value) {
  return workspacePlanSchema.parse(value);
}
