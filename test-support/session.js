// Every test entry point imports this before index.js or anything under lib/: a session id and an
// instance launcher inherited from the session running the tests would give those modules an agent
// instance, and the tests would then act on a game they never asked for. A file that wants one sets
// its own session id and points BROFORCE_INSTANCE_CMD, BROFORCE_LAUNCH_CMD or BROFORCE_STOP_CMD at a
// stub of its own.
export const NO_OP_LAUNCH_CMD = 'sh -c "exit 0"';
// Port 1 has no listener and refuses a connect at once. Nothing else here is a fence against the
// user's own game answering: with UNITY_INSPECTOR_PORT unset the `steam` target falls back to 9999,
// which is the port the user's real game listens on, and the tests would run their commands in it
export const NO_LISTENER_PORT = '1';

delete process.env.CLAUDE_SESSION_ID;
delete process.env.BROFORCE_INSTANCE_CMD;
// Not deleted but neutralised: with it unset, a launch_game on the `steam` target is the Steam
// protocol launch, and that starts the user's real game. Every test entry point gets a command that
// does nothing instead, and a test that wants its own sets its own
process.env.BROFORCE_LAUNCH_CMD = NO_OP_LAUNCH_CMD;
// The second fence: the server refuses the Steam protocol launch outright while this is set, so a
// test that unsets BROFORCE_LAUNCH_CMD gets a tool error where it would have started the game
process.env.UNITY_INSPECTOR_TEST = '1';
process.env.UNITY_INSPECTOR_PORT = NO_LISTENER_PORT;
delete process.env.BROFORCE_STOP_CMD;
// The wrapper hands its child this path to record the owner.pid it wrote; inherited, it would have
// the tests writing a claim into a live session's wrapper file
delete process.env.UNITY_INSPECTOR_MCP_CLAIM_FILE;
