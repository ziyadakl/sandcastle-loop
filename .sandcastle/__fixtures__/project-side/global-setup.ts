// Reference copy of the project-side Playwright global setup. See README.txt.
// Read as TEXT by lib/db/observed-db.contract.test.ts.
declare const db: { execute(q: string): Promise<{ current_database: string }[]> };

export default async function globalSetup(): Promise<void> {
  // `current_database()` names the database the run actually resolved to; the
  // loop parses this line host-side and refuses to certify green when it is
  // not the clone it minted for the job.
  const rows = await db.execute("select current_database()");
  const observed = rows[0]?.current_database;
  if (observed) {
    console.log(`SANDCASTLE_OBSERVED_DB:${observed}`);
  }
}
