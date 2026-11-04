# SimilarityHint

One row of the duplicate check: verdict, similarity score, the matching item and what to do next.

**Provide** the verdict (`duplicate` ≥ 0.90, `related` ≥ 0.84, `new` below), the score with two decimals, the matched item's ID and title, and a one-line next step.

- `duplicate`: `danger-soft` ground; the item was not created. Say so plainly and name both ways forward (open the match, or `--allow-duplicate`).
- `related`: neutral `surface` with a `line-strong` edge; suggest a relation, never block.
- `new`: `signal-soft`; one row, no match shown.
- Matches across languages are normal: show the matched title in its own language, unmodified.
- When `semantic: false` (no model or no `sqlite-vec`), add "keyword match only" to the note so people know the check was weaker.
