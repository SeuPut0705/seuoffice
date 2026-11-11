---
name: mindmap
description: 'Build a mind map from a topic, notes or an attached document: choose the kind of map the purpose needs, find the central topic and three to seven balanced main branches, write short topic titles with the detail in notes, then check the structure. Use when asked to make a map, turn material into one, or restructure and tidy a map.'
metadata:
  ieum-editors: mindmap
---

# Making a mind map

A good map shows the shape of a subject at a glance: what the parts are, how they group, what belongs under what. This skill is about that shape. How the tools work is already in your instructions.

The tool names below are those of the mind map editor's AI panel. In another window, do the same steps with the tools that window gives you.

## 1. Choose the kind of map

| The user wants to | Main branches are | Notes |
| --- | --- | --- |
| Understand or summarise a text | The text's main ideas | Not its chapter order, unless the text is a procedure |
| Plan a project or an event | Goal, scope, tasks by phase, people, schedule, risks | Leave out a branch the material has nothing for |
| Collect ideas | The groups the ideas fall into | List the ideas first, then name the groups |
| Compare or decide | The options | Give every option the same sub-branches (cost, benefit, risk) so they line up |
| Study a subject | The key concepts | Under each: definition, examples, how it relates to the others |
| Record a meeting | The agenda items | Under each: what was decided, who does what by when |
| Show a process or a timeline | The steps or periods, in order | Start each title with its number or date so the order survives any layout |

## 2. Shape rules

- **Central topic:** the subject itself in five words or fewer. Not a sentence, not "Mind map of …".
- **Main branches:** three to seven. All the same kind of thing (all phases, or all categories, never a mix), not overlapping, and in a deliberate order: time, importance or the flow of an argument.
- **No only children.** A topic with exactly one subtopic means the two should be one topic, or the detail belongs in the note.
- **Depth:** up to four levels unless the user asks for more. Go deep only where the content is; branches need not be equally deep.
- **Balance:** when one branch holds more than about half of all topics, split it into two branches or lift its children up a level.
- **Titles are keywords, not sentences:** one to five words (about fifteen characters in Korean), no ending punctuation, no "etc.". Siblings share one grammatical form: all nouns, or all verb phrases.
- **Detail goes into the note** (`> ` lines in the outline): definitions, figures, quotations, reasons. **Sources go into the link** (`<https://…>`). **Labels** (`[ … ]`) carry status, owner, date or type, with one small vocabulary used the same way across the map, three labels at most on a topic.
- **Facts come from the material.** Keep the terms the source uses. Cover every major part of an attachment or say which you left out. Do not fill a thin branch with invented items.
- **Relationships are rare:** draw one only for a real dependency or cause that crosses branches, give it a short verb as its title, and keep to a handful per sheet. If two topics in different branches say the same thing, keep one and relate it instead of repeating it.
- **Size:** an overview is 15 to 30 topics, a working map 30 to 80. Past about 100, split into sheets (one `# ` heading each, ten at most), with the first sheet as the overview.

## 3. Build it

- **A new map, or a map from material:** write the whole outline in one `write_map` call, then check it (section 4). On a map that already has content `write_map` adds a new sheet and leaves the others as they are; to change a sheet that is there, use `edit_map`.
- **A map that is already there:** `read_map`, then `edit_map`. Restructure with `move`; deleting a topic and adding it again loses its note, picture and format.
- **Tidying a map:** fix the shape first (merge only children, split overloaded branches, shorten titles into notes), then wording. Keep the user's own terms.
- **Emphasis:** leave the look to the theme. Make at most one or two key topics bold with `set_format` when that helps reading; change line or text colours only when the user asks.
- **What you cannot set:** the layout (both sides, one side, tree, timeline), the theme, markers such as priority or progress, new summaries and new boundaries. When one of these would help, for example the timeline layout for a process, say so in your reply; the user picks it in the editor.

```
# Product launch
- Product launch
  - Goal
    - 1,000 sign-ups in month one
      > Target agreed at the March planning meeting
    - 50 paying teams
  - Audience
    - Small teams
    - Freelancers
  - Channels
    - Newsletter [owner: Mina]
    - Launch page <https://example.com/launch>
  - Schedule
    - 1 Beta: April
    - 2 Public launch: May
  - Risks
    - Late pricing decision [open]
    - Support load
```

## 4. Check before you answer (required)

Read the map with `read_map` and go through this list. Fix what fails with `edit_map`, then answer.

- One central topic; three to seven main branches.
- No topic with exactly one subtopic.
- No two siblings with the same title; no idea repeated in two branches.
- No title longer than five words or shaped like a sentence; the detail is in notes.
- Siblings share one grammatical form.
- No deeper than four levels unless the user asked.
- Every major part of the source material is placed, or named in your reply as left out.
- Labels use one vocabulary.

In your reply say in one or two sentences what the map holds (how many main branches and topics), what you left out or assumed, and any layout or theme the user may want to pick.
