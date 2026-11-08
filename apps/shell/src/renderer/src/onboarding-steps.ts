/**
 * The first-run onboarding as data: its three steps and how one moves between
 * them. No step waits for anything — in particular the connect step can be
 * left without a subscription connected.
 */

export const ONBOARDING_STEPS = ['welcome', 'connect', 'done'] as const

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]

/** the step where the subscription connection is offered */
export const ONBOARDING_CONNECT_STEP = ONBOARDING_STEPS.indexOf('connect')

export function isLastOnboardingStep(index: number): boolean {
  return index >= ONBOARDING_STEPS.length - 1
}

/** Where "Next" leads from a step; `null` means the onboarding is finished */
export function nextOnboardingStep(index: number): number | null {
  return isLastOnboardingStep(index) ? null : Math.max(0, index) + 1
}

/** Where "Back" leads from a step; the first step stays put */
export function previousOnboardingStep(index: number): number {
  return Math.max(0, Math.min(index, ONBOARDING_STEPS.length - 1) - 1)
}
