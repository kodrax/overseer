# Button

Two variants: `ov-btn--primary` (signal fill, `on-signal` text) and `ov-btn--quiet` (transparent, `line-strong` edge).

**Provide** a verb-first label in sentence case ("New item", "Export", "Record requirement"); optionally a `<kbd>` shortcut.

- One primary per view. On the board header that is "New item"; in the New item dialog it is the record action.
- There is no delete or destructive variant: items are never deleted, they close with a status. Closing is a status change, done through the status control.
- Disabled buttons keep their label and say why next to them (for example a duplicate hint), never a tooltip only.
- Height 32px, `radius-md`, label in 13px sans 500. Focus is the shared `focus-ring`.
