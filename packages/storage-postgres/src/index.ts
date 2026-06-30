import { Pool } from "pg";
import { PostgresStorage } from "./storage";

export { PostgresStorage };

export function createPostgresStorage(connectionString: string): PostgresStorage {
  return new PostgresStorage(new Pool({ connectionString }));
}
