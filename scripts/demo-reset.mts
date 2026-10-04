/** npm run demo:reset — deletes only the demo user's application rows. */
import { resetDemoUser } from "../src/server/demo/reset";
import { getPool } from "../src/server/db/client";

const subject = process.env.DEMO_USER_SUBJECT || "demo-user";
await resetDemoUser(subject);
console.log(`reset demo user "${subject}"`);
await getPool().end();
