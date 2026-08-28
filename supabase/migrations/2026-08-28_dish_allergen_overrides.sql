-- Dish-level manual allergen overrides
--
-- Backs the "By Menu" allergen sheet's manual toggle (aToggle() in
-- dashboard.html) — lets a chef flag or unflag an allergen directly on a
-- whole dish, overriding/supplementing what's auto-detected from its
-- ingredients (e.g. cross-contamination risk that isn't captured by
-- composition alone). Previously this lived only in the browser's
-- localStorage; this table makes it a real, shared, audited record.
--
-- Run this once in the Supabase SQL editor (or via the CLI) against the
-- project. Not auto-applied by anything in this repo.

create table if not exists dish_allergen_overrides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  user_id uuid not null references auth.users(id) on delete set null,
  dish_id uuid not null references dishes(id) on delete cascade,
  allergen_id text not null,
  created_at timestamptz not null default now(),
  unique (dish_id, allergen_id)
);

create index if not exists dish_allergen_overrides_dish_id_idx
  on dish_allergen_overrides (dish_id);
create index if not exists dish_allergen_overrides_company_id_idx
  on dish_allergen_overrides (company_id);

alter table dish_allergen_overrides enable row level security;

-- Same company-scoping shape used throughout this app (see api/_auth.js /
-- getCallerProfile): a caller may only see or touch rows whose company_id
-- matches their own profile's company_id. Adjust here if your existing
-- policies on dishes/ingredients use a different pattern -- these should
-- match whatever convention those already use.

create policy "select own company overrides"
  on dish_allergen_overrides for select
  using (
    company_id = (select p.company_id from profiles p where p.user_id = auth.uid())
  );

create policy "insert own company overrides"
  on dish_allergen_overrides for insert
  with check (
    company_id = (select p.company_id from profiles p where p.user_id = auth.uid())
  );

create policy "delete own company overrides"
  on dish_allergen_overrides for delete
  using (
    company_id = (select p.company_id from profiles p where p.user_id = auth.uid())
  );

-- No update policy: aToggle() only ever inserts or deletes a row (a "manual
-- override" is either present or absent, there's nothing to edit in place).
