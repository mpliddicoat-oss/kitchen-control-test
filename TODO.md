# TODO / Notes for next session

## Print Label — phase 2 (2026-09-03)

Print Label (single-item, Days/Months shelf life, USE BY box, allergens,
notes, logo) is built and confirmed working on staging. Production is
intentionally still on the pre-Print-Label version until this feature is
fully tested end to end.

Next phase, per Matt:

- Add a **shelf life** field to Ingredients, Yields, and Recipes (a
  default value stored on the item itself, e.g. "3 days" / "2 weeks").
- Add a **Print Label** button directly on each Ingredient, Yield, and
  Recipe detail page (not just the standalone search-and-print flow on
  the dashboard).
- When printing from an item's own page, **auto-fill the label's shelf
  life field** from that item's stored default where available, instead
  of requiring it to be typed in every time. Still editable per print
  (e.g. for a decanted/backdated batch).
