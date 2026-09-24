// npm's engine-strict only gates `npm install`, not `npm run`, so a shell left on
// an older Node reaches vitest and better-sqlite3's native binding aborts the
// worker mid-import. Vitest reports that as fewer files run, not as a failure,
// so the suite looks green while whole files never executed. Fail loudly first.
const REQUIRED_MAJOR = 24;
const actual = process.versions.node;

if (Number(actual.split(".")[0]) !== REQUIRED_MAJOR) {
  console.error(
    `\ncalsync requires Node ${REQUIRED_MAJOR}.x — this shell has v${actual}.\n` +
      `better-sqlite3's native binding aborts the test workers on other versions.\n\n` +
      `  nvm use    # honours .nvmrc\n`,
  );
  process.exit(1);
}
