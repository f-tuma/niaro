import { attachmentClientHttp } from "./attachment-client-http";
async function main() {
  const fixture = await attachmentClientHttp();
  process.stdout.write(JSON.stringify({ address: fixture.address }) + "\n");
  process.on("SIGTERM", () => {
    void fixture.close().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void fixture.close().then(() => process.exit(0));
  });
}
void main();
