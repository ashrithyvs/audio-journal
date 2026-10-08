# UI/UX Design Files

The durable interactive design is:

- `audio-journal-ui-prototype.html` — standalone review build. Open it directly
  in a browser; it includes the interactive Lock, Diary, Organized, Record,
  Entry, Organize, Tasks, task-source, Settings, and Backup flows.
- `audio-journal-ui.fragment.html` — editable source fragment used to regenerate
  the standalone review build.

The authoritative product rules remain in `../ux-design.md` and
`../visual-design.md`. The prototype illustrates those rules but must not silently
override them.

## Recommended format

Standalone HTML is the best primary review format for this stage because it is:

- interactive without requiring the React Native app to exist;
- portable and viewable offline in a browser;
- versionable in Git;
- able to demonstrate navigation and states that a PNG cannot;
- easy to regenerate while preserving Markdown as the design source of truth.

PNG screenshots can be added later for pull-request previews, and Figma may be
introduced for production handoff if a design workflow needs precise component
measurements. Neither replaces the versioned UX/visual specification.

## Regeneration

Use the repository fragment as input to the visualization renderer available in
the active Codex environment, writing the result back to
`audio-journal-ui-prototype.html`. Then verify at compact and large phone widths.
