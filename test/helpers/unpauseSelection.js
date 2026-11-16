// Test-only snapshot for existing scenarios. Race tests retain an earlier snapshot explicitly.
async function unpauseSelection(shepherd) {
  return Promise.all([shepherd.mode(), shepherd.primarySource(), shepherd.backupSource()]);
}

module.exports = { unpauseSelection };
