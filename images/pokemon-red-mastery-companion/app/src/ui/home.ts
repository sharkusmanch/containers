/**
 * Home-screen selection over the existing plan. It only orders and filters planner output;
 * readiness, checkpoints and completion remain the planner's own assessments.
 */
import type { CheckpointAssessment, PlanInput, PlannedAction, RouteStep, RunPlan } from '../model'
import { eligibleCompletion } from '../planner/route'
import { suggestedStage } from '../planner/display'

const canonicalRoute = (input: PlanInput) =>
  [...input.dataset.route].filter((s) => !s.id.startsWith('glitch-')).sort((a, b) => a.order - b.order)

/** Done means recorded in this attempt (save story flag or the player's own mark) or a confirmed hardcore unlock. */
export function actionDone(input: PlanInput, plan: RunPlan, action: PlannedAction): boolean {
  return action.ruleIds.every(
    (id) => eligibleCompletion(input, id) || plan.achievements.find((a) => a.ruleId === id)?.hardcoreEarned,
  )
}
const ruleActions = (plan: RunPlan, stepId: string) =>
  plan.actions.filter((a) => a.routeStepId === stepId && !a.id.startsWith('stage-'))

/**
 * Where the player is: after the last badge earned (in route order), then forward past any
 * stage whose achievements are all done. Glitch/speedrun attempts keep the planner's suggestion.
 */
export function homeStage(input: PlanInput, plan: RunPlan): string {
  if (input.attempt.kind !== 'canonical') return suggestedStage(input)
  const route = canonicalRoute(input)
  const s = input.attempt.snapshot
  let floor = 0
  if (s?.badgeMask.known) {
    const badges = s.badgeMask.value
    const has = (step: RouteStep) => !!step.checkpoint && (badges & step.checkpoint.badgeMask) !== 0
    // The first unbeaten leader (an order group counts from its first member) bounds progress, so
    // out-of-order badges never skip earlier stages; otherwise start after the last beaten leader.
    let gap = route.findIndex((step) => step.checkpoint && !has(step))
    const group = gap >= 0 ? route[gap]!.checkpoint!.orderGroup : undefined
    if (group) gap = route.findIndex((r) => r.checkpoint?.orderGroup === group)
    const limit = gap >= 0 ? gap : route.length
    route.forEach((step, i) => {
      if (i < limit && step.checkpoint && has(step)) floor = Math.max(floor, i + 1)
    })
  }
  // Oak's five-ball gift closes the Pallet stage's ordering window.
  if (s?.events.known && s.events.value.EVENT_GOT_POKEBALLS_FROM_OAK) floor = Math.max(floor, 1)
  // Within an order-free group, skip leaders already beaten and the stages that only lead up to them.
  const inGroup = route.filter((r) => r.checkpoint?.orderGroup)
  const isBeaten = (r: RouteStep) => !!s?.badgeMask.known && (s.badgeMask.value & r.checkpoint!.badgeMask) !== 0
  const beaten = inGroup.filter(isBeaten), open = inGroup.filter((r) => !isBeaten(r))
  // A preparation stage is passed only when it leads to beaten leaders alone (Cinnabar quiz → Blaine, not Articuno).
  const stillNeeded = new Set(open.flatMap((r) => r.afterStepIds ?? []))
  const passed = new Set([...beaten.map((r) => r.id), ...beaten.flatMap((r) => r.afterStepIds ?? []).filter((id) => !route.find((r) => r.id === id)?.checkpoint && !stillNeeded.has(id))])
  for (let i = Math.min(floor, route.length - 1); i < route.length; i++) {
    if (passed.has(route[i]!.id) && i < route.length - 1) continue
    const actions = ruleActions(plan, route[i]!.id)
    if (actions.some((a) => !actionDone(input, plan, a))) return route[i]!.id
  }
  return route.at(-1)!.id
}

export interface HomeAction { action: PlannedAction; step: RouteStep }
/** The next few unfinished achievements in route order, starting at the given stage. */
export function nextActions(input: PlanInput, plan: RunPlan, stageId: string, limit = 5): HomeAction[] {
  const route = canonicalRoute(input)
  const start = Math.max(0, route.findIndex((s) => s.id === stageId))
  const result: HomeAction[] = []
  for (const step of route.slice(start)) {
    for (const action of ruleActions(plan, step.id)) {
      if (result.length >= limit) return result
      if (!actionDone(input, plan, action)) result.push({ action, step })
    }
  }
  return result
}

/** The first Oak gym checkpoint at or after the stage (Cinnabar's quiz visit belongs to Blaine). */
export function upcomingCheckpoint(input: PlanInput, plan: RunPlan, stageId: string): { step: RouteStep; assessment: CheckpointAssessment } | undefined {
  const route = canonicalRoute(input)
  const start = Math.max(0, route.findIndex((s) => s.id === stageId))
  const step = route.slice(start).find((s) => s.checkpoint)
  const assessment = step && plan.checkpoints.find((c) => c.stepId === step.id)
  return step && assessment ? { step, assessment } : undefined
}

/** Unfinished achievements in earlier stages (not shown in the next-actions list). */
export function earlierOpen(input: PlanInput, plan: RunPlan, stageId: string): HomeAction[] {
  const route = canonicalRoute(input)
  const before = route.slice(0, Math.max(0, route.findIndex((s) => s.id === stageId)))
  return before.flatMap((step) => ruleActions(plan, step.id).filter((a) => !actionDone(input, plan, a)).map((action) => ({ action, step })))
}

/** Achievements in earlier stages the planner marks as possibly missed, for a gentle warning. */
export function possiblyMissed(input: PlanInput, plan: RunPlan, stageId: string): PlannedAction[] {
  const route = canonicalRoute(input)
  const before = new Set(route.slice(0, Math.max(0, route.findIndex((s) => s.id === stageId))).map((s) => s.id))
  return plan.actions.filter(
    (a) => before.has(a.routeStepId) && !a.id.startsWith('stage-') && a.readiness === 'missed' && !actionDone(input, plan, a),
  )
}
