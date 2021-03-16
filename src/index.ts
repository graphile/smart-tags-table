import {
  makePgSmartTagsPlugin,
  PgSmartTagRule,
  UpdatePgSmartTagRulesCallback,
} from "graphile-utils";
import {
  getPgClientAndReleaserFromConfig,
  PgEntityKind,
} from "graphile-build-pg";
import type { Plugin } from "graphile-build";
import { Client, Pool } from "pg";

/**
 * A promise that you can resolve externally.
 */
interface Deferred<T = void> extends Promise<T> {
  resolve: (result: T | PromiseLike<T>) => void;
  reject: (error: Error) => void;
}

/**
 * Generates a Deferred.
 */
function defer<T = void>(): Deferred<T> {
  let resolve: (result: T | PromiseLike<T>) => void;
  let reject: (error: Error) => void;
  return Object.assign(
    new Promise<T>((_resolve, _reject) => {
      resolve = _resolve;
      reject = _reject;
    }),
    // @ts-ignore error TS2454: Variable 'resolve' is used before being assigned.
    { resolve, reject },
  );
}

/**
 * Performs `fn` with a PostgreSQL client from `pgConfig`, returning the result
 * and releasing the client automatically.
 */
async function withPgClient<T>(
  pgConfig: Client | Pool | string,
  fn: (pgClient: Client) => Promise<T>,
): Promise<T> {
  const { pgClient, releasePgClient } = await getPgClientAndReleaserFromConfig(
    pgConfig,
  );
  const errorHandler = (e: Error) => {
    // eslint-disable-next-line no-console
    console.error(
      "@graphile/smart-tags-table withPgClient client error:",
      e.message,
    );
  };
  pgClient.on("error", errorHandler);
  try {
    return await fn(pgClient);
  } finally {
    pgClient.removeListener("error", errorHandler);
    try {
      releasePgClient();
    } catch (e) {
      // Failed to release, assuming success
    }
  }
}

/**
 * PostgreSQL client errors are handled elsewhere; this exists simply so the
 * node process doesn't exit.
 */
function ignoreError() {}

/**
 * A description of the rows that will come back from the database; it's the
 * implementors responsibility to ensure this contract is adhered to (see the
 * README).
 */
interface SmartTagsRecord {
  kind: "class" | "attribute" | "constraint" | "procedure";
  identifier: string;
  description: string | null;
  tags: { [tagName: string]: true | string | string[] };
}

/**
 * A Graphile Engine Plugin that reads smart tags rules from a database table
 * (by default `public.smart_tags`) and applies them to the generated GraphQL
 * schema. Useful if you want your smart tags to be dynamically editable by
 * users.
 */
const SmartTagsTablePlugin: Plugin = async (builder, options) => {
  const { pgConfig, smartTagsTable = "smart_tags" } = options;

  /**
   * Our smart tag rules, generated from the database (see `reload()` below).
   * These will be populated once before resolving the plugin promise, and will
   * be populated again in watch mode when the relevant database event occurs.
   */
  let rules: PgSmartTagRule[] = [];

  /** Where we send updated rules. */
  let watchCallback: UpdatePgSmartTagRulesCallback | null = null;

  /**
   * The client we're using in watch mode, stored as promise to try and avoid
   * race conditions.
   */
  let clientPromise: null | Promise<{
    pgClient: Client;
    releasePgClient: () => void;
  }> = null;

  /** True when a reload is in progress */
  let reloading = false;

  /**
   * If another reload was triggered whilst a reload is in progress, this
   * becomes a promise to a secondary execution; this ensures only one reload
   * can happen at a time and further that all concurrent reload events are
   * coalesced into a single reload action.
   */
  let reloadAgainPromise: Deferred<void> | null = null;

  /**
   * Reads from the smart tags table and converts the records therein into
   * PgSmartTagRules which are stored into the plugin scope `rules` variable.
   */
  async function reload(pgClient: Client) {
    if (reloading) {
      if (!reloadAgainPromise) {
        reloadAgainPromise = defer();
      }
      return reloadAgainPromise;
    }
    reloading = true;
    try {
      const { rows } = await pgClient.query<SmartTagsRecord>(
        `select * from ${smartTagsTable}`,
      );
      rules = rows.map((row) => {
        const rule: PgSmartTagRule = {
          kind: row.kind as PgEntityKind,
          match: row.identifier,
          description: row.description ?? undefined,
          tags: row.tags,
        };
        return rule;
      });
    } finally {
      reloading = false;
      if (reloadAgainPromise) {
        const d = reloadAgainPromise;
        reloadAgainPromise = null;
        reload(pgClient).then(
          () => d.resolve(),
          (e) => d.reject(e),
        );
      }
    }
    return;
  }

  /**
   * When passed a callback enables watch mode; when passed null clears watch
   * mode. Watch mode subscribes to the `smart_tags_table` topic in PostgreSQL
   * and when an event is received it re-introspects the database.
   */
  async function watch(callback: UpdatePgSmartTagRulesCallback | null) {
    watchCallback = callback;
    if (callback) {
      if (!clientPromise) {
        // TODO: this consumes an entire pool entry just to watch this one
        // thing, like PostGraphile watch mode does. All these clients could be
        // the same client.
        clientPromise = getPgClientAndReleaserFromConfig(pgConfig);
        const { pgClient } = await clientPromise;
        pgClient.on("error", ignoreError);
        pgClient.on("notification", (notification) => {
          if (notification.channel !== "smart_tags_table") {
            return;
          }
          reload(pgClient)
            .then(() => (watchCallback ? watchCallback(rules) : null))
            .catch((e) => {
              console.error(e);
            });
        });
        await pgClient.query("listen smart_tags_table");
      }
    } else {
      if (clientPromise) {
        const p = clientPromise;
        clientPromise = null;
        p.then(({ pgClient, releasePgClient }) => {
          pgClient.removeListener("error", ignoreError);
          releasePgClient();
        });
      }
    }
  }

  // Load the initial rules; if an error occurs (e.g. we cannot read from the
  // DB) then we throw since these rules could potentially be critical (e.g.
  // `@omit`) so continuing without them is undesirable. Shouly you need that
  // the schema can start without a database connection, you should use a
  // file-based smart tags plugin instead.
  await withPgClient(pgConfig, (client) => reload(client));

  // Use makePgSmartTagsPlugin to manage these rules.
  const plugin = makePgSmartTagsPlugin(rules, watch);
  plugin(builder, options);

  return;
};

export default SmartTagsTablePlugin;
