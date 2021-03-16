# @graphile/smart-tags-table

This plugin allows you to store smart tags into a database table rather than
using [database comments](https://www.graphile.org/postgraphile/smart-comments/)
or [a dedicated file](https://www.graphile.org/postgraphile/smart-tags-file/).

In general, using the other approaches are preferred. This plugin is primarily
intended for applications which are allowing users to manipulate the GraphQL
schema at run time; and as such we've added watch mode support.

## Usage

From the CLI you can install this plugin and run using command line
`postgraphile`:

```
yarn add postgraphile @graphile/smart-tags-table
yarn postgraphile --append-plugins @graphile/smart-tags-table -c postgres://localhost/my_db --watch
```

This requires that you have a table `smart_tags` as defined below.

In library mode you can use `appendPlugins` to install the plugin, and you can
also choose the name of the table via the `smartTagsTable` option within
`graphileBuildOptions`:

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

(Your table still needs to conform to the same layout as below.)

**NOTE**: watch mode consumes (very inefficiently) an entire PostgreSQL client
just for this plugin, so your pg pool needs to be at least size 3 if you are
using watch mode (default is 10). Addressing this will require changes to the
way that watch mode works throughout PostGraphile/Graphile Engine so the changes
have not been made yet.

## Smart tags table

You must add a table to your database to store the smart tags (that's the entire
point of this plugin :wink:). The table follows a similar pattern to the entries
in a JSON smart tags file, namely:

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

A minimal implementation of the smart tags table would be as such:

```sql
create table public.smart_tags (
  kind text not null,
  identifier text not null,
  description text,
  tags json not null default '{}',
  unique (kind, identifier)
);
```

A more full implementation with validation rules could be something like:

```sql
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
create table public.smart_tags (
  id serial primary key,
  kind text not null check(kind in ('class', 'attribute', 'constraint', 'procedure')),
  identifier text not null,
  description text,
  tags json not null default '{}' check(public.is_valid_smart_tags_json(tags)),
  unique (kind, identifier)
);
```

Technically you don't need the function and the check constraints, and you may
make the primary key whatever you like - we don't use it;

## Thanks 🙏

This plugin was originally sponsored by [Surge](http://surge.io/) 🙌