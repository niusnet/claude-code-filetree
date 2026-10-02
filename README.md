<h1 align="center">Claude Code Filetree</h1>

<p align="center">
  An IDE-style file tree for Claude Code that shows what Claude is doing and where in files
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-%E2%89%A5_2.1.287-D97757?logo=claude&logoColor=fff" alt="Claude Code 2.1.287 or newer">
  <img src="https://img.shields.io/badge/version-0.2.17-blue" alt="Version">
  <img src="https://img.shields.io/badge/type-mod-6f42c1" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

<p align="center">
  <img src="media/filetree-shimmer.gif" alt="filetree shimmering the file Claude is editing" width="900">
</p>

> [!NOTE]
> filetree is a Claude Code **mod**: a plugin of function hooks with its own pane. Mods need **Claude Code 2.1.287 or newer**.
>
> filetree lives in the sidebar on the right, full height and resizable. That needs Claude Code's **fullscreen** layout (`/tui fullscreen`, or `"tui": "fullscreen"` in `~/.claude/settings.json`) and a terminal at least 110 columns wide; tmux keeps Claude Code out of fullscreen unless you turn it on. In the default layout filetree stays hidden instead of sitting above the prompt, and `/filetree` tells you how to switch. Works the same in any terminal; tested in Ghostty, Alacritty and foot.
>
> Tested by hand in the terminal on Linux. macOS, the Code tab of the Claude Desktop app and Windows are covered by `claude plugin test` (see `tests/`) in CI. Mods do not load in WSL sessions of the Desktop app.

---

## Installation

The repo is its own plugin marketplace. Run this in the terminal:

```bash
claude plugin marketplace add data-goblin/claude-code-filetree
claude plugin install filetree@claude-code-filetree
```

Or inside a Claude Code session:

```text
/plugin marketplace add data-goblin/claude-code-filetree
/plugin install filetree@claude-code-filetree
```

Installed it as `filetree@filetree` before the repository was renamed? Nothing to do: that install keeps loading and keeps receiving updates.

## Features

- Interactive file tree for the working directory where you're using Claude Code; it follows the cwd, or `/filetree <path>` pins another folder
- Search the file tree, including folders you have not opened yet
- Git status per file and folder in color, with exact lines changed (`+N` `-N`) on modified files and `?:N M:N D:N` file counts on folders
- Branch, upstream and ahead/behind in the header
- Visual indicator of Claude reads and searches (purple), writes (orange) and commits (green); collapsed folders open to show the file

  <img src="media/filetree-read.gif" alt="Files shimmer purple while Claude reads and searches them" width="800">

- Git and GitHub operations via `git` and `gh` (commit, push, pull, checkout, merge, PR and more) shown as a status at the bottom of the pane

  <img src="media/filetree-git.gif" alt="A committed file shimmers green and the footer shows the commit" width="800">

- Selection-aware: the selected file is passed to Claude as context through a `prompt.submit` hook, and `@path` mentions in a prompt reveal that file in the tree

  <img src="media/filetree-ask.gif" alt="Selecting config.yaml in the tree and asking Claude what it changed there" width="800">

- Double-click a file to open it in its default app
- Click to select, arrow keys to move through the tree
- Light on large repos: outside a repo it only checks once whether one exists, and every git call is scoped to the cwd
- Nerd Font icons with a plain Unicode fallback

### Resizing the pane

You can resize the pane with the mouse, or by setting custom `pane:grow` or `pane:shrink` keybindings in `keybindings.json`

<p align="center">
  <img src="media/filetree-resize.gif" alt="Dragging the filetree pane edge to resize it" width="900">
</p>

## Settings

Both settings are in `/config` under filetree.

- **Claude activity:** what shimmers: `reads and writes` (default), `writes`, `reads` or `none`. Git status, line counts and the git status at the bottom always show.
- **Glyphs:** `auto` (default) uses Nerd Font icons when a Nerd Font is installed and your terminal started after it was installed, plain Unicode in the desktop app, and Nerd Font over SSH. `nerd` or `plain` forces one.

## Fork changes

This fork (niusnet/claude-code-filetree) adds four things on top of upstream.

- **`/filetree` toggles.** With no path, `/filetree` closes the pane when it is open ("File tree closed.") and opens it when it is not. A path (`/filetree ~/src`) always opens or retargets the pane. Closing it with the engine's own close mark or Esc is tracked too, so the next `/filetree` opens it again.
- **Own close control.** The engine draws a close mark at the top right of every pane and a plugin cannot move or hide it. The tree now has its own `x: close` button in the bottom row, on the left. Press it with the mouse or with `x` while the pane has the keys (typing in the search box types the letter instead).
- **No more clipped glyphs in narrow panes.** The row width math assumed a 24 column minimum and always reserved the modified time, so in a narrow dock the right-hand columns were pushed past the pane edge and the last glyph (the Nerd Font "ignored" icon) was cut in half. Rows now fit the real pane width: names shrink first (never below 8 cells), then the modified time and line counts are dropped, the git status letter stays, and the Nerd Font ignored icon keeps a blank cell after it. Wide characters in names (CJK, emoji) are counted as two cells.
- **Diff on demand.** Select a file git reports as modified, added, deleted or untracked and press `d`, or click its `+N -N` counts or its status letter on the right of the row. A second pane (`Diff: <file>`) shows `git diff HEAD -- <file>` (`git diff --no-index /dev/null <file>` for untracked files) drawn with the engine's diff highlighter. Plain clicks and double-clicks keep their meaning (select, open with the default app). Close it with `x`, its `close` button or Esc. Diffs are cut at 10000 characters (whole hunks, with a note of how many lines were left out); binary files, empty diffs, files without changes, folders and folders outside a repository say so instead of opening an empty pane.

## herdr

Clicking rows needs herdr 0.9.1 or later. herdr 0.9.0 and older accept pixel mouse reporting but still send cell positions, which would put every click in the session in the wrong place, so on those versions the rows ignore the mouse and the rest of the pane and session keep working. Run `herdr update` to get row clicks.

## Contributing

Turn on the pre-commit hook once per clone; it runs `claude plugin validate` and the plugin tests before each commit that touches the plugin:

```bash
git config core.hooksPath .githooks
```

The same checks run on macOS, Windows and Linux in CI on every push that touches the plugin.

## License

[MIT](LICENSE)

*This project is inspired by my Omarchy app [FileBlade](https://github.com/data-goblin/fileblade)*
