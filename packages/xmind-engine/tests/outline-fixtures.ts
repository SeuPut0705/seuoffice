import type { XmindSheet } from '../src/types'

/**
 * A map, built by hand, that uses everything the outline writes: labels, a web
 * link and a link that is not one, a plain note with a blank line, a note in
 * rich form only, a title of several lines, a folded topic, a summary with a
 * branch below it, a callout, a floating topic with a branch, a boundary with
 * and one without a title, a relationship with and one without text, and a
 * second sheet.
 */
export function tripSheets(): XmindSheet[] {
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      rootTopic: {
        id: 'root',
        class: 'topic',
        title: 'Summer trip',
        children: {
          attached: [
            {
              id: 'a',
              title: 'Places',
              labels: ['must see', 'coast'],
              href: 'https://example.com/places?x=1&y=2',
              notes: { plain: { content: 'Book early.\n\nAsk <b>Mina</b> & co.\n' } },
              branch: 'folded',
              children: {
                attached: [
                  { id: 'a1', title: 'Old\n  town  \nwalls' },
                  {
                    id: 'a2',
                    title: 'Harbour',
                    children: { attached: [{ id: 'a2x', title: 'Ferry times' }] },
                  },
                  { id: 'a3', title: 'Museum' },
                ],
                summary: [
                  {
                    id: 'sum',
                    title: 'Two days',
                    children: { attached: [{ id: 'sum1', title: 'Split evenly' }] },
                  },
                ],
                callout: [{ id: 'call', title: 'Closed on Mondays' }],
              },
              boundaries: [
                { id: 'bound', range: '(1,2)', title: 'Indoors' },
                { id: 'bound-2', range: '(0,0)' },
              ],
              summaries: [{ id: 'sum-rec', range: '(0,1)', topicId: 'sum' }],
            },
            { id: 'b', title: 'Budget', href: 'xmind:#a' },
            {
              id: 'c',
              title: 'Packing',
              notes: { realHTML: { content: '<div>Light</div><div>Rain coat</div>' } },
            },
          ],
          detached: [
            {
              id: 'float',
              title: 'Ideas',
              labels: ['later'],
              position: { x: 10, y: 20 },
              children: { attached: [{ id: 'float1', title: 'Kayak' }] },
            },
          ],
        },
      },
      relationships: [
        { id: 'rel', end1Id: 'a3', end2Id: 'b', title: 'costs' },
        { id: 'rel-2', end1Id: 'a1', end2Id: 'c' },
      ],
      title: 'Trip',
    },
    { id: 'sheet-2', title: '둘째 시트', rootTopic: { id: 'root', title: '중심' } },
  ]
}
