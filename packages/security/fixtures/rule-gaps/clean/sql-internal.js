// Near-misses for bpm-js-sql-string-concat graded on outline (2026-10-29,
// docs/benchmarks/rule-grade-w22-07): an identifier the class generates for
// itself, a module constant in LIMIT, and a table name read back from
// pg_tables. None of them is input. The AI judge spent its whole 30-minute
// budget on six hits of exactly these shapes and could not rule on any.
const BATCH_SIZE = 1000;

class PopularityTask {
  constructor(sequelize) {
    this.sequelize = sequelize;
    this.workingTable = `popularity_working_${process.pid}`;
  }

  async prepare() {
    await this.sequelize.query(`CREATE INDEX ON ${this.workingTable} (processed)`);
    await this.sequelize.query(`SELECT "documentId" FROM ${this.workingTable} LIMIT ${BATCH_SIZE}`);
  }
}

async function backfill(queryInterface) {
  await queryInterface.sequelize.query(
    `UPDATE documents SET "deletedById" = "lastModifiedById" WHERE id IN (SELECT id FROM documents LIMIT ${BATCH_SIZE})`,
  );
}

module.exports = { PopularityTask, backfill };
