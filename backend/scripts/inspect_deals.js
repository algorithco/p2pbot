const { db } = require('../dist/db/queries');

(async () => {
  try {
    const res = await db.query(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_name='deals'",
    );
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
