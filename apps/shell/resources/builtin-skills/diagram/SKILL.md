---
name: diagram
description: 'Draw a clear diagram: pick the diagram type that answers the question, write it as Mermaid when the type fits or place shapes on a grid when it does not, keep one flow direction, short labels and few colours, then check the page for overlaps, loose shapes and unlabelled decisions. Use for flowcharts, processes, org charts, sequences, timelines, ER and class diagrams, and architecture pictures.'
metadata:
  ieum-editors: diagram
---

# Drawing a diagram

A diagram answers one question: what happens after what, who talks to whom, what is part of what. This skill is about choosing the right picture and keeping it readable. How the tools work is already in your instructions.

The tool names below are those of the diagram editor's AI panel. In another window, do the same steps with the tools that window gives you.

## 1. Choose the type from the question

| The question | Type | How |
| --- | --- | --- |
| What happens step by step, with choices? | Flowchart | `insert_mermaid`, `flowchart TD` |
| How does work pass along a pipeline or over time? | Flowchart, left to right | `insert_mermaid`, `flowchart LR` |
| What is part of what (org chart, breakdown)? | Flowchart with no decisions | `insert_mermaid`, `flowchart TD` |
| Who sends what to whom, in order? | Sequence diagram | `insert_mermaid`, `sequenceDiagram` |
| Which states does one thing pass through? | State diagram | `insert_mermaid`, `stateDiagram-v2` |
| Which tables or entities relate, and how? | ER diagram | `insert_mermaid`, `erDiagram` |
| Which classes, with which members? | Class diagram | `insert_mermaid`, `classDiagram` |
| What is scheduled when? | Gantt chart | `insert_mermaid`, `gantt` |
| Which systems sit in which zones; swimlanes; anything with free placement or notes | Shapes placed by hand | `add_shape`, `add_edge` |

One page answers one question. More than about twenty nodes means two questions: split them with `add_page`, the first page being the overview.

## 2. Before you draw

- List the nodes and name each in four words or fewer (about twelve characters in Korean): a noun phrase for a thing, verb plus object for a step. The same kind of node gets the same form.
- A decision is a question ending in `?`, and **every line leaving it carries its answer** (Yes / No, or the case). A process has a visible start and a visible end.
- Pick one direction and keep it: top to bottom for steps with choices and for hierarchies, left to right for pipelines and time. Only a loop may run backwards.
- Use the names the user's material uses. Do not add steps, systems or people it does not mention; ask or say what you assumed.

## 3. Mermaid that converts

```
flowchart TD
  start([Request received]) --> check{"Complete?"}
  check -->|Yes| review["Review (2 days)"]
  check -->|No| back[Return to sender]
  back --> start
  review --> done([Approved])
```

- **Ids are plain ASCII with no spaces** (`check`, `step2`); the text people read goes in the brackets. Never use `end` as an id.
- **Quote a label** that holds anything but letters, digits and spaces: `a["비용 (천원)"]`, `b["A/B test"]`.
- Node shapes: `[step]`, `([start or end])`, `{decision}`, `[(data store)]`. An edge label goes between pipes: `a -->|Yes| b`.
- One statement per line. Keep each label on one line; shorten it instead of breaking it.
- Leave out `style`, `classDef` and theme lines. Colour the drawing afterwards (section 5) if it needs colour.
- Group with `subgraph Title` … `end` only when the groups mean something (a team, a system, a phase).
- When the converter refuses the text, the simplest fix is usually a quoted label or a removed subgraph. Fix and send the call again.

## 4. Shapes placed by hand

- **Use a grid.** With the default size (120 × 60), put columns 200 apart and rows 120 apart: `x = 40 + 200 × column`, `y = 40 + 120 × row`. Shapes in one column share `x`, shapes in one row share `y`.
- **One meaning per shape, the same everywhere:** `rounded` start or end, `rectangle` step or component, `rhombus` decision, `parallelogram` input or output, `cylinder` data store, `document` document, `actor` person, `cloud` outside system, `note` remark, `text` free label.
- **Same kind, same size.** For a long label make every shape of that kind wider (160 to 200) rather than letting one wrap, and widen the grid with it: columns are the width plus 80 apart (`x = 40 + (width + 80) × column`).
- **`shape` and `style` do not add up in `add_shape`:** a `style` there replaces the look of the shape. Create the shape with `shape` alone, then colour it with `update`, whose `style` is merged in.
- **Zones and swimlanes:** add the zone first as a large `rectangle` with an `id`, then add its members with `parent` set to that id and positions counted from the zone's corner, 40 in from its edges. Then `update` the zone with `verticalAlign=top;dashed=1;fillColor=none;` so its title sits at the top and its members stay readable.
- **Lines:** you choose the two ends; no argument sets the path. Order the shapes so lines run one way and rarely cross. Keep line labels to a word or two.
- Give every shape an `id` you choose (`login`) and send shapes and lines in one call, shapes first.

## 5. Colour

No colour is a good default. Add it only when it carries meaning, three fills at most, each meaning one thing (for example: ours, theirs, at risk). When more than one fill is used, add a small legend with `note` or `text` shapes. Use these pairs:

| | fillColor | strokeColor |
| --- | --- | --- |
| Blue | `#dae8fc` | `#6c8ebf` |
| Green | `#d5e8d4` | `#82b366` |
| Yellow | `#fff2cc` | `#d6b656` |
| Orange | `#ffe6cc` | `#d79b00` |
| Red (problems only) | `#f8cecc` | `#b85450` |
| Purple | `#e1d5e7` | `#9673a6` |
| Grey | `#f5f5f5` | `#666666` |

## 6. Changing a diagram that is there

Keep its positions, sizes, colours and wording; match them in what you add. Put new shapes into free space on its grid. Do not lay the page out again unless the user asks.

## 7. Check before you answer (required)

Read the page with `read_diagram` and go through this list on the table it returns. Fix what fails, then answer.

- **No overlaps:** for any two shapes with the same parent, the boxes `x … x+width` by `y … y+height` do not intersect, and they are at least 40 apart. (A zone and its own members are the exception.)
- **No loose shapes:** every shape except notes, legends, titles, zones and the empty group a Mermaid drawing comes in has at least one line.
- **Decisions are answered:** every decision has two or more outgoing lines, each labelled.
- **One direction:** targets sit below (or to the right of) their sources, loops aside.
- **Same kind, same shape and size;** no label cut short or wrapped into three lines.
- Names match the user's material; nothing invented.

In your reply say in one or two sentences what the diagram shows and what you assumed. After a Mermaid drawing, mention that double-clicking it opens its source for editing.
