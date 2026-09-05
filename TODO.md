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

### Shelf life -- DONE (2026-09-03), including the Supabase migration

Ingredients, Yields and Recipes all have a Shelf Life field (value +
Days/Months unit, matching the Print Label form) in their edit forms, and
the Print Label form auto-fills from it via `plSelect()` when you print
from an item's own "Print Label" button (still fully editable per print,
e.g. for a decanted/backdated batch).

Editing it is restricted to Owner, Head Chef and Sous Chef -- it lives
inside the same Ingredient/Yield/Recipe form as every other field, which
is already gated by the existing `canEdit()` check on Save
(`_userRole==='owner'||'head_chef'||'sous_chef'`).

Matt ran the `shelf_life_value`/`shelf_life_unit` migration on the shared
Supabase project (no errors), so syncing across devices is now fully
live for staging and production alike -- no further action needed.

## PPDS labelling -- "Single Ingredient" flag (staging only)

The PPDS warning on a dish (missing ingredients breakdown) used to fire for
*any* ingredient with no Full Ingredients List recorded -- including raw,
single-item ingredients like a lime or an egg, which don't have a product
label to paste from and are frustrating to have to fill in just to clear
the warning.

Added a "This is a single, unprocessed ingredient" checkbox to the
Ingredient form. When ticked, the ingredient is treated as its own complete
declaration and the PPDS warning no longer flags it, without needing
anything typed into Full Ingredients List. Existing ingredients default to
unticked, so nothing already flagged (e.g. ketchup, mayo) silently stops
being flagged -- it's an explicit per-ingredient opt-in, not a change to
the default behaviour.

Needs a migration on the shared Supabase project (same pattern as shelf
life -- saves gracefully degrade via `isMissingColumnError` until it's run):

```sql
alter table ingredients add column if not exists single_ingredient boolean default false;
```

## PPDS labelling -- "Label Name" field (staging only)

Ingredients pulled in from a scanned invoice often carry the supplier's
full product description (e.g. "Lime -- Sea Freight"), which isn't what
should print on a label or appear in a dish's PPDS ingredients list.

Added a "Label Name" field to the Ingredient form, right under Ingredient
Name. It live-mirrors the ingredient name as you type (so it auto-fills
with no extra effort in the common case) until manually edited, at which
point it stops auto-syncing -- e.g. type "Lime" over the auto-filled
"Lime -- Sea Freight" once and it stays "Lime" from then on. Falls back to
the ingredient's own name everywhere if never customised. Used for: the
name shown on that ingredient's own Print Label, and the name shown for it
within a dish's PPDS ingredients list (including via yields/recipes that
use it).

Needs a migration on the shared Supabase project (same graceful-degradation
pattern):

```sql
alter table ingredients add column if not exists label_name text default '';
```
