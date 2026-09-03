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
  the dashboard). **DONE (2026-09-03), deployed to staging.** Each
  edit form's header now shows a "Print Label" button when editing an
  existing item (hidden when adding a new one) that jumps straight to
  that item's Print Label form via a new `plGoTo(type, id)` helper --
  no need to re-search for it on the dashboard. Uses only existing
  item data (name, allergens), so no database changes were needed.
- When printing from an item's own page, **auto-fill the label's shelf
  life field** from that item's stored default where available, instead
  of requiring it to be typed in every time. Still editable per print
  (e.g. for a decanted/backdated batch).

### Shelf life -- blocked on a Supabase schema migration

This session has no Supabase schema-modification credentials, so I
could not add a `shelf_life` column myself. Adding it to the save
payload without the column existing would break every ingredient/
yield/recipe save app-wide (staging and production share one
database), so this was intentionally left undone rather than risked
unsupervised.

When you're back online, run this in the Supabase SQL editor (safe:
nullable columns, no default that could break existing rows or
in-flight saves):

```sql
alter table ingredients
  add column if not exists shelf_life_value numeric,
  add column if not exists shelf_life_unit text default 'days';

alter table yields
  add column if not exists shelf_life_value numeric,
  add column if not exists shelf_life_unit text default 'days';

alter table recipes
  add column if not exists shelf_life_value numeric,
  add column if not exists shelf_life_unit text default 'days';
```

Once those columns exist, say the word and I'll:
1. Add a "Shelf life" field to the Ingredient/Yield/Recipe forms
   (value + unit, e.g. "3" / "days"), wired into the save/load
   payloads.
2. Auto-fill the Print Label form's shelf-life field from that
   default when printing via the new per-item "Print Label" button
   (still editable per print for a decanted/backdated batch).
