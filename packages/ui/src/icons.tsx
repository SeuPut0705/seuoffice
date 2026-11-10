import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
}

function Svg({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function IconSend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.2 8 13.8 2.6 11 13.4 7.6 9.6z" strokeLinejoin="round" />
      <path d="M7.6 9.6 13.8 2.6" />
    </Svg>
  )
}

export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** return/enter arrow (↵) for the icon-only send button */
export function IconEnter(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3.5v4a2.5 2.5 0 0 1-2.5 2.5H3.5" />
      <path d="M6.5 7 3.5 10l3 3" />
    </Svg>
  )
}

/** pencil for the queued-message edit action */
export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.3 3.2l3.5 3.5L6 13.5l-4 .5.5-4z" strokeLinejoin="round" />
      <path d="M8.2 4.3l3.5 3.5" />
    </Svg>
  )
}

/** trash can for the queued-message remove action */
export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" strokeLinejoin="round" />
      <path d="M6.7 7v3.8M9.3 7v3.8" />
    </Svg>
  )
}

/** broom for the clear-queue action */
export function IconBroom(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.6 2.4L8.5 7.5" />
      <path d="M6.2 5.2l4.6 4.6" strokeLinejoin="round" />
      <path d="M7.8 8.4L4 12.2c-.8-.2-1.6-1-1.8-1.8L6 6.6z" strokeLinejoin="round" />
      <path d="M3.2 13.6c1.2.4 2.4.4 3.4-.1" />
    </Svg>
  )
}

/** chevron down for the queue strip's expand toggle */
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6l4 4 4-4" strokeLinejoin="round" />
    </Svg>
  )
}

/** two bars: hold the queue where it is */
export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4v8" />
      <path d="M10 4v8" />
    </Svg>
  )
}

/** triangle: let the queue run again */
export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 3.5l7 4.5-7 4.5z" strokeLinejoin="round" />
    </Svg>
  )
}

/** close / dismiss / remove */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

/** move up, previous item */
export function IconArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 13V3M4 7l4-4 4 4" strokeLinejoin="round" />
    </Svg>
  )
}

/** move down, next item */
export function IconArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M4 9l4 4 4-4" strokeLinejoin="round" />
    </Svg>
  )
}

/** back */
export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3M7 4L3 8l4 4" strokeLinejoin="round" />
    </Svg>
  )
}

/** chosen, done */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5l3 3 6-7" strokeLinejoin="round" />
    </Svg>
  )
}

/** previous page */
export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 4L6 8l4 4" strokeLinejoin="round" />
    </Svg>
  )
}

/** next page */
export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4l4 4-4 4" strokeLinejoin="round" />
    </Svg>
  )
}

/** a table was added */
export function IconTable(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M2.5 7.5h11M7 3.5v9" />
    </Svg>
  )
}

/** a picture was added */
export function IconPicture(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M3 11l3-3 2.5 2.5 2-2 2.5 2.5" strokeLinejoin="round" />
    </Svg>
  )
}
