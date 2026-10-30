import { existsSync } from "node:fs";
import { bootstrapRustFS } from "../apps/server-storage/bootstrap";
import { storageFailure } from "../apps/server-storage/adapter";
if (existsSync(".env")) process.loadEnvFile(".env");
void bootstrapRustFS()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(
      JSON.stringify({ ok: false, code: storageFailure(error).code }),
    );
    process.exitCode = 1;
  });
