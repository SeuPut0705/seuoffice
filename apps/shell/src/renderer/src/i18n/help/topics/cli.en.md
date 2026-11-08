# Command line and agents

Every install ships an `ieumoffice` command that drives the same engines the window does — the same parsers, the same writer, the same renderer. A file the app saves and a file the command writes are the same file, and a check the app's AI panel passes is a check the command passes.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` is the whole surface in one screen: every command with a line saying what it does, then the global options and the exit codes.

## Getting the command

The command ships inside the app. To use it by name, run `ieumoffice install-cli` once: on Windows it adds the folder that holds the command to your user `PATH`, and terminals you open afterwards find it. **Settings ▸ Integrations** shows whether your terminal already finds the command and, if it does not, the exact line to run.

Coding agents do not need that step. The app records where the command is in `~/.ieumoffice/launcher`, and they find it there.

## The commands worth knowing

| Command           | What it does                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Open a document in the app; starts the app if it is not running.                                                                                                                                                    |
| `selection`       | What the user has selected in that file right now, while the app is running — the pointer for "this one" / "here". Returns a block range, a sheet range, slide elements or a page, whichever editor the file is in. |
| `convert`         | Convert between formats using the app's own engines.                                                                                                                                                                |
| `create`          | Create a document from structured content.                                                                                                                                                                          |
| `render`          | One PNG per page, as the renderer lays it out.                                                                                                                                                                      |
| `pdf`             | Read a PDF's text layer page by page, with no app process.                                                                                                                                                          |
| `read-url`        | Read the text of a web page from the command line — an article, a document, or a skill's link; prints the text and continues with `--offset`.                                                                       |
| `info`            | Metadata and a structure summary of a document.                                                                                                                                                                     |
| `search`          | Web or image search: the free search by default, or the search provider whose key you selected in the app.                                                                                                          |
| `image` / `media` | Generate an image, or describe and ask questions about an image, video or audio file.                                                                                                                               |
| `merge`           | Fill `{{key}}` placeholders in a `.docx`, `.pptx` or `.xlsx` template.                                                                                                                                              |
| `capabilities`    | Report which AI features (search, image generation, image and video analysis) are available on this machine, and by which route.                                                                                    |
| `guide`           | The op reference and design guides, generated from the same definitions the executor validates against — so it cannot drift from what `apply` accepts. `--json` returns it with each op's schema.                   |
| `install-cli`     | Put `ieumoffice` on the `PATH`.                                                                                                                                                                                     |
| `skill`           | List the coding agents found on this machine and install or update the GenOffice skill in them.                                                                                                                     |
| `mcp`             | Serve every command as a Model Context Protocol tool. See **Connecting a coding agent**.                                                                                                                            |

## Editing: docs, sheets, slides

Each of `ieumoffice docs`, `ieumoffice sheet` and `ieumoffice slides` takes a sub-command first — `read`, `apply`, `check`, and for slides `audit`, `render`, `replace` — and goes through the same write path the app uses. They share one vocabulary: an **op** is a single edit, and a **spec** is a list of ops applied in order.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` reports what a batch would do and writes nothing, which is the cheap way to check a spec before it lands. The AI panel in the app runs on exactly these ops, so anything you can ask it to do you can script.

## Search, image and media commands

`search`, `image` and `media` use what is set up in the app under Settings ▸ AI ▸ Advanced:

- `search` always works. It uses the free search by default, or the search provider whose key you selected.
- `image` needs an image provider key. In this version a subscription does not generate images.
- `media` on a picture uses a key provider when one is set up. It uses your Claude or Codex subscription only when you have allowed that, and that is **off by default**; [Connecting a coding agent](help://mcp) explains the switch and its limits.
- `media` on video or audio needs a key provider that supports video.

`ieumoffice capabilities --json` reports all of this without calling any AI. Its `detail` holds:

| Field                                                                            | What it says                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | For each feature: `available`; `via`, who answers; `route`, one of `free`, `key` or `subscription`; `metered: true` for a pay-as-you-go login; and, when the feature is unavailable, `message`, the text the command itself answers with. |
| `media_analysis`                                                                 | Kept for older scripts: the same as `image_analysis`, or as `video_analysis` when only video works.                                                                                                                                       |
| `automatic_calls`                                                                | `subscription_enabled`, and while that is on, `used`, the automatic requests handled in the last hour (for information only), with `limit` and `remaining` always `null`.                                                                 |
| `app`                                                                            | `available`: whether the app is installed where the command can start it.                                                                                                                                                                 |
| `settings_path`                                                                  | The settings file these answers were read from.                                                                                                                                                                                           |

When `image` or `media` cannot run, the command exits with code 4 and `error: "app_unavailable"`, and `detail.errorCode` says why. `unavailable` means nothing is set up for the feature, so trying again will not help. `rate-limit` comes with `detail.resetsAt`, the time (in milliseconds) when requests are possible again.

## What it keeps on this PC

Both files are in the `.ieumoffice` folder inside your user folder:

- `~/.ieumoffice/launcher` records where the app's command is, so a coding agent finds it even when it is not on your `PATH`.
- `~/.ieumoffice/cli-audit.jsonl` gets one line for every command that was run — the command, its arguments and the result — so you can see afterwards what an agent did.

## Model Context Protocol

`ieumoffice mcp` serves every command as an MCP tool, and `ieumoffice mcp install <agent|all>` registers it in a coding agent's own config. See **Connecting a coding agent** for that side.

## What the command does not do

It reads and writes the file. It is not the app: there is no window, and the in-app update dialog does not apply. Anything that needs the window — the AI panel, the QC pass over a rendered slide — has to wait for you to open the file. `ieumoffice render` gets you the pixels without it, and `ieumoffice slides` audits a deck's layout on its own.
