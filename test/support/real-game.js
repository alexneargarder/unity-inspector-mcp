export async function withNoRealGame(t, gameIsRunning, reason, body) {
  if (await gameIsRunning()) {
    t.skip(reason);
    return;
  }
  try {
    await body();
  } catch (err) {
    if (!(await gameIsRunning())) throw err;
    t.skip(`a real Broforce process started during the test, which failed with: ${err.message}`);
  }
}
