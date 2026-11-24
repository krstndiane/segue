/**
 * A KeyValueStore backed by one DynamoDB table, so every Lambda copy shares
 * the same place, place-name and weather answers.
 *
 * Item shape: pk = cache key, sk = "v1", v = JSON value, ttl = expiry in epoch
 * seconds (the table's TTL attribute). DynamoDB removes expired items lazily,
 * so expiry is also checked on read.
 *
 * A cache problem must never break a request: a failed read is a miss and a
 * failed write is skipped, both logged without the key (keys hold geohashes).
 */
import type { KeyValueStore } from '@segue/providers';

type Attr = { S?: string; N?: string };

/** The two DynamoDB calls this store needs (matches the AWS SDK v3 DynamoDB client), so tests can pass a fake. */
export interface DynamoLike {
  getItem(input: { TableName: string; Key: Record<string, Attr>; ConsistentRead?: boolean }): Promise<{ Item?: Record<string, Attr> }>;
  putItem(input: { TableName: string; Item: Record<string, Attr> }): Promise<unknown>;
}

export const SORT_KEY = 'v1';

export class DynamoStore<T> implements KeyValueStore<T> {
  constructor(
    private readonly client: DynamoLike,
    private readonly table: string,
    private readonly clock: () => number = Date.now,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  async get(key: string): Promise<T | undefined> {
    try {
      const { Item } = await this.client.getItem({ TableName: this.table, Key: { pk: { S: key }, sk: { S: SORT_KEY } } });
      if (!Item?.v?.S) return undefined;
      const expires = Number(Item.ttl?.N ?? 0) * 1000;
      if (!expires || expires <= this.clock()) return undefined;
      return JSON.parse(Item.v.S) as T;
    } catch (e) {
      this.log(`cache read failed: ${(e as Error).name}`);
      return undefined;
    }
  }

  async set(key: string, value: T, ttlMs: number): Promise<void> {
    try {
      const ttl = Math.ceil((this.clock() + ttlMs) / 1000);
      await this.client.putItem({ TableName: this.table, Item: { pk: { S: key }, sk: { S: SORT_KEY }, v: { S: JSON.stringify(value) }, ttl: { N: String(ttl) } } });
    } catch (e) {
      this.log(`cache write failed: ${(e as Error).name}`);
    }
  }
}

/**
 * The real client, loaded only when CACHE_STORE=dynamodb. The SDK is not bundled
 * into server.js: the Lambda package ships it in node_modules (infra/scripts/package-api.sh),
 * and hosts that never use DynamoDB never load it.
 */
export async function realDynamoClient(): Promise<DynamoLike> {
  const sdk = '@aws-sdk/client-dynamodb';
  const { DynamoDB } = (await import(sdk)) as { DynamoDB: new (cfg: object) => DynamoLike };
  return new DynamoDB({});
}
