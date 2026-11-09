import type { DefaultAppStatus } from '../../shared/home-api'

/**
 * The first-run onboarding as data: its steps and how one moves between them.
 * Which steps a run shows is decided once, from what is known when it opens,
 * so the dots never change under the user. No step waits for anything: the
 * connect step can be left without a subscription connected, the default-app
 * step without changing the default.
 */

export type OnboardingStepId = 'welcome' | 'connect' | 'defaultApp' | 'done'

export interface OnboardingFacts {
  /** null while the status is still being read */
  defaultApp: DefaultAppStatus | null
}

export function onboardingSteps({ defaultApp }: OnboardingFacts): readonly OnboardingStepId[] {
  const offerDefaultApp = defaultApp?.state === 'other' || defaultApp?.state === 'unknown'
  return offerDefaultApp
    ? ['welcome', 'connect', 'defaultApp', 'done']
    : ['welcome', 'connect', 'done']
}

export function isLastOnboardingStep(index: number, steps: readonly OnboardingStepId[]): boolean {
  return index >= steps.length - 1
}

/** Where "Next" leads from a step; `null` means the onboarding is finished */
export function nextOnboardingStep(
  index: number,
  steps: readonly OnboardingStepId[],
): number | null {
  return isLastOnboardingStep(index, steps) ? null : Math.max(0, index) + 1
}

/** Where "Back" leads from a step; the first step stays put */
export function previousOnboardingStep(index: number, steps: readonly OnboardingStepId[]): number {
  return Math.max(0, Math.min(index, steps.length - 1) - 1)
}
