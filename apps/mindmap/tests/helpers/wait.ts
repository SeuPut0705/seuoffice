import { act } from 'react'

/**
 * Turn the event loop until `done` holds. The engine reads and writes the zip
 * with JSZip, which works in steps it schedules itself: how many of them fit in
 * one turn depends on how fast the machine is, so a fixed number of turns runs
 * out on a slow CI runner before a file has opened or a save has been made.
 */
export async function until(
  done: () => boolean,
  what: string,
  { react = true }: { react?: boolean } = {},
): Promise<void> {
  const deadline = Date.now() + 15_000
  const turn = () => new Promise((resolve) => setTimeout(resolve, 5))
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`still waiting for ${what}`)
    // a test without React (the map controller alone) has nothing for act to flush
    if (react) await act(turn)
    else await turn()
  }
}

/** The editor in `container` has left "Loading…": the map, or why it did not open, is shown */
export const mapLoaded = (container: HTMLElement): boolean =>
  ![...container.querySelectorAll('.center-note')].some((note) => note.textContent === 'Loading…')
