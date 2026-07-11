/**
 * Plugin migrations for membership.
 *
 * Tables:
 *   - membership_tiers   : tier definitions (gold / silver / free, with display name + price)
 *   - subscriptions      : user's subscription to a tier, with start/end/trial/cancel state
 *
 * Content gating uses the `tier` field on each cell — a row's "members-only" flag
 * is checked against the viewer's active subscription tier via the contentGate extension.
 *
 * Subscription lifecycle states:
 *   trialing  → active (when trial ends and payment succeeds)
 *   active    → past_due (payment failed, grace period)
 *   past_due  → canceled (grace period elapsed)
 *   canceled  → (terminal, can resubscribe)
 */

export default [
  {
    id: 'membership.001_initial_schema',
    pgSql: `
      create table if not exists membership_tiers (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        rank integer not null default 0,
        price_cents integer not null default 0,
        currency text not null default 'USD',
        billing_interval text not null default 'month',
        stripe_price_id text,
        features_json jsonb not null default '[]',
        is_default boolean not null default false,
        is_public boolean not null default true,
        sort_order integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint membership_tiers_billing_interval_check
          check (billing_interval in ('month', 'year', 'one_time'))
      );

      create index if not exists membership_tiers_public_idx
        on membership_tiers (sort_order, rank)
        where deleted_at is null and is_public = true;

      -- Seed two starter tiers so a fresh install is immediately usable.
      insert into membership_tiers (id, slug, name, description, rank, price_cents, currency, billing_interval, is_default, features_json, sort_order)
      values
        ('free', 'free', 'Free', 'Read public content.', 0, 0, 'USD', 'one_time', true, '["Public posts"]', 0),
        ('premium', 'premium', 'Premium', 'Full archive + member-only posts.', 10, 999, 'USD', 'month', false, '["All posts","Member-only posts","Newsletter"],' || '"price-cancel-anytime"', 10)
      on conflict (id) do nothing;

      create table if not exists subscriptions (
        id text primary key,
        user_id text not null,
        tier_id text not null references membership_tiers(id) on delete restrict,
        status text not null default 'trialing',
        trial_ends_at timestamptz,
        current_period_start timestamptz not null default now(),
        current_period_end timestamptz not null,
        canceled_at timestamptz,
        cancel_at timestamptz,
        stripe_subscription_id text,
        metadata_json jsonb not null default '{}',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint subscriptions_status_check
          check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete'))
      );
    `,
    sqliteSql: `
      create table if not exists membership_tiers (
        id text primary key,
        slug text not null unique,
        name text not null,
        description text not null default '',
        rank integer not null default 0,
        price_cents integer not null default 0,
        currency text not null default 'USD',
        billing_interval text not null default 'month',
        stripe_price_id text,
        features_json text not null default '[]',
        is_default integer not null default 0,
        is_public integer not null default 1,
        sort_order integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at text,
        constraint membership_tiers_billing_interval_check
          check (billing_interval in ('month', 'year', 'one_time'))
      );

      create index if not exists membership_tiers_public_idx
        on membership_tiers (sort_order, rank)
        where deleted_at is null and is_public = 1;

      insert into membership_tiers (id, slug, name, description, rank, price_cents, currency, billing_interval, is_default, features_json, sort_order)
      values
        ('free', 'free', 'Free', 'Read public content.', 0, 0, 'USD', 'one_time', 1, '["Public posts"]', 0),
        ('premium', 'premium', 'Premium', 'Full archive + member-only posts.', 10, 999, 'USD', 'month', 0, '["All posts","Member-only posts","Newsletter"]', 10)
      on conflict (id) do nothing;

      create table if not exists subscriptions (
        id text primary key,
        user_id text not null,
        tier_id text not null references membership_tiers(id) on delete restrict,
        status text not null default 'trialing',
        trial_ends_at text,
        current_period_start text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        current_period_end text not null,
        canceled_at text,
        cancel_at text,
        stripe_subscription_id text,
        metadata_json text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        constraint subscriptions_status_check
          check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete'))
      );
    `,
  },
  {
    id: 'membership.002_subscription_indexes',
    pgSql: `
      create unique index if not exists subscriptions_user_active_unique
        on subscriptions (user_id)
        where status in ('trialing', 'active', 'past_due');

      create index if not exists subscriptions_user_idx
        on subscriptions (user_id, status, current_period_end desc);

      create index if not exists subscriptions_stripe_idx
        on subscriptions (stripe_subscription_id)
        where stripe_subscription_id is not null;
    `,
    sqliteSql: `
      create unique index if not exists subscriptions_user_active_unique
        on subscriptions (user_id)
        where status in ('trialing', 'active', 'past_due');

      create index if not exists subscriptions_user_idx
        on subscriptions (user_id, status, current_period_end desc);

      create index if not exists subscriptions_stripe_idx
        on subscriptions (stripe_subscription_id)
        where stripe_subscription_id is not null;
    `,
  },
]