import { resolve } from "node:path";
import { issuePairingCode } from "./auth";
const [user, workspace] = process.argv.slice(2);
if (!user || !workspace || process.argv.length !== 4) {
  console.error("Usage: npm run fixture:pair -- <synthetic-user-id> <a|b>");
  process.exitCode = 1;
} else {
  const code = issuePairingCode(
    resolve(process.env.FIXTURE_DATA_DIR ?? ".fixture"),
    user,
    workspace,
  );
  console.log(
    `One-use pairing code for ${user} / ${workspace}, valid five minutes:\n${code}`,
  );
}
