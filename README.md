# @graphile/smart-tags-table

This plugin allows you to store
[smart tags](https://www.graphile.org/postgraphile/smart-tags/) into a database
table rather than using
[database comments](https://www.graphile.org/postgraphile/smart-comments/) or
[a dedicated file](https://www.graphile.org/postgraphile/smart-tags-file/).

In general, using the other approaches are preferred. This plugin is primarily
intended for applications which are allowing users to manipulate the GraphQL and
maybe even database schema at run time.

## Usage

Please note you have to create a `smart_tags` table as described
[below](#smart-tags-table); we do not do this for you.

From the CLI you can install this plugin and run using command line
`postgraphile`:

```
yarn add postgraphile @graphile/smart-tags-table
yarn postgraphile --append-plugins @graphile/smart-tags-table -c postgres://localhost/my_db --watch
```

In library mode you can use `appendPlugins` to install the plugin, and you can
also choose the name of the table via the `smartTagsTable` option within
`graphileBuildOptions` (should you wish to override it):

```js
app.use(
  postgraphile(process.env.DATABASE_URL, process.env.SCHEMA_NAME, {
    appendPlugins: [require("@graphile/smart-tags-table")],
    watchPg: true,
    graphileBuildOptions: {
      smartTagsTable: "public.smart_tags",
    },
  }),
);
```

**NOTE**: watch mode consumes (very inefficiently) an entire PostgreSQL client
just for this plugin, so your pg pool needs to be at least size 3 if you are
using watch mode (default is 10). Addressing this will require changes to the
way that watch mode works throughout PostGraphile/Graphile Engine; the changes
have not been made yet.

## Smart tags table

You must add a table to your database to store the smart tags (that's the entire
point of this plugin :wink:). The table follows a similar pattern to the
[entries in a JSON smart tags file](https://www.graphile.org/postgraphile/make-pg-smart-tags-plugin/#makejsonpgsmarttagsplugin),
namely:

- `kind` - one of:
  - `class` - for tables, views, materialized views, compound types and other
    table-like entities; things you'd find in the
    [`pg_class` PostgreSQL system table](https://www.postgresql.org/docs/current/catalog-pg-class.html).
  - `attribute` - for columns/attributes of a `class`; things you'd find in the
    [`pg_attribute` PostgreSQL system table](https://www.postgresql.org/docs/current/catalog-pg-attribute.html).
  - `constraint` - for constraints; things you'd find in the
    [`pg_constraint` PostgreSQL system table](https://www.postgresql.org/docs/current/catalog-pg-constraint.html).
  - `procedure` - for functions and procedures; things you'd find in the
    [`pg_proc` PostgreSQL system table](https://www.postgresql.org/docs/current/catalog-pg-proc.html)
- `identifier` - the textual representation of the entity to apply the tags to,
  this will differ based on the `kind`:
  - `class` - `schema_name.table_name`
  - `attribute` - `schema_name.table_name.column_name`
  - `constraint` - `schema_name.table_name.constraint_name`
  - `procedure` - `schema_name.function_name`
  - NOTE: since PostGraphile doesn't support function overloading, function
    parameters are not factored into the identifier.
  - NOTE: you may omit from the left until and including a period (`.`), this
    will make the matching fuzzier which may result in applying the tags to
    multiple identically named entities in different schemas/tables/etc; for
    example the `id` column in a table `app_public.users` could be referred to
    as `app_public.users.id` or `users.id` or just `id`.
- `description` - optionally override the documentation for this entity (rather
  than pulling from the relevant PostgreSQL comment).
- `tags` - a JSON object containing the tags to apply to the entity; the values
  within this object must be the boolean `true`, a string, or an array of
  strings. All other values are invalid and may have unexpected consequences.

A minimal implementation of the smart tags table would be:

```sql
create table public.smart_tags (
  kind text not null,
  identifier text not null,
  description text,
  tags json not null default '{}',
  unique (kind, identifier)
);
```

A fuller implementation with validation rules and support for watch mode could
be something like:

```sql
-- This is an optional validation function used in the `check` constraint
-- below; you don't need it, but you do need to adhere to these rules.
create function public.is_valid_smart_tags_json(tags json)
returns boolean as $$
  -- Must be an object
  select json_typeof(tags) = 'object'
  and not exists(
    select 1
    -- And each value in the object...
    from json_each(tags)
    -- Must be 'true':
    where value::text <> 'true'
    -- Or a string:
    and json_typeof(value) <> 'string'
    -- Or an array of strings:
    and (
      json_typeof(value) <> 'array'
      or exists(
        select 1
        from json_array_elements(value) v2
        where json_typeof(v2) <> 'string'
      )
    )
  );
$$ language sql immutable;

-- Your smart_tags table; you may rename this if you wish but you must tell
-- PostGraphile what it's called via `graphileBuildOptions.smartTagsTable` as
-- shown in usage above.
create table public.smart_tags (
  -- We don't care what kind of primary key you use, nor what you call it.
  id serial primary key,

  -- These columns are required to have the names and types as stated, the
  -- check constraints are optional.
  kind text not null check(kind in ('class', 'attribute', 'constraint', 'procedure')),
  identifier text not null,
  description text,
  tags json not null default '{}' check(public.is_valid_smart_tags_json(tags)),

  -- We require there's a unique index/constraint (or primary key
  -- constraint) on these columns.
  unique (kind, identifier)
);

-- This trigger function is used to notify PostGraphile that something has
-- changed within the table; you only need this if you intend to support watch
-- mode.
create function public.tg_smart_tags__notify() returns trigger as $$
begin
  perform pg_notify('smart_tags_table'::text, ''::text);
  return null;
end;
$$ language plpgsql;

-- This trigger is for watch mode, calling the function above.
create trigger smart_tags_changed
  after insert or update or delete on public.smart_tags
  for each statement
  execute procedure public.tg_smart_tags__notify();
```

## Thanks 🙏

This plugin was originally sponsored by [Surge](http://surge.io/) 🙌
