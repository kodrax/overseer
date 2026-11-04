# LintNote

A warning from `report lint`, `report drift` or the warnings returned on create and update.

**Provide** a short uppercase tag (`WARN` for lint, `DRIFT` for drift), one sentence naming the item and the problem, and one sentence with the fix.

- `warn-soft` ground, tag in `warn`, text in `ink`. A full rounded box, never a colored left border.
- Warnings never block a write. Show them after the item is saved, beside it, not in a modal.
- Quote the offending term in `code` style ("vague term `"rápido"`"); lint covers English and Spanish terms.
- Errors are not LintNotes: `DISABLED` and `NO_PROJECT` use `danger` and the CLI error format.
