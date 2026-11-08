export interface AiMarkProps {
  size?: number
  className?: string
}

/**
 * Neutral mark for the AI entry points (ribbon button, panel header, launcher
 * chips): a rounded-square speech bubble holding a ring. It names no AI
 * vendor, so it stays correct whichever provider the user has connected.
 *
 * Drawn inline with `currentColor` so it follows the surrounding text color in
 * both themes and stays crisp at device resolution. The reference drawing is
 * apps/shell/build/brand/ai-mark.svg; keep the two in sync.
 */
export function AiMark({ size = 18, className }: AiMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5h-6l-4.2 3.4a.6.6 0 0 1-1-.5v-3.1A3.5 3.5 0 0 1 3.5 14V7A3.5 3.5 0 0 1 7 3.5z" />
      <circle cx="12" cy="10.5" r="2.6" />
    </svg>
  )
}
