// The only module that loads Ryugi code. `contract` is everything the bridge borrows from the
// installed plugin besides its CLI: doctor checks each entry, and the worker restarts when one changes.
const os = require("node:os");
const path = require("node:path");
// This stable plugin path is refreshed by `ryugi update`.
const plugin = path.resolve(
  process.env.RYUGI_T3_PLUGIN || path.join(os.homedir(), ".local/share/ryugi/install/plugins/pi/plugin"),
);
const launcher = path.join(plugin, "skills/artifacts/app/ryugi.cjs");
const hook = path.join(plugin, "hooks/selection-context.cjs");
const contract = {
  "skills/artifacts/app/comment-subscriptions.cjs": ["projectRoot", "subscriptionFile", "aliveFile", "beat"],
  "skills/artifacts/app/comment-watch.cjs": ["createCommentWatch", "wakeMessage", "unreadCount"],
  "skills/artifacts/app/agent-event.cjs": ["postToServer"],
  "hooks/selection-context.cjs": [],
};
// Only used to trim the hook's unread reminder from selection-context, so doctor just warns without them.
const reminderHelpers = ["commentReminders", "cursorKey"];
const load = (file) => require(path.join(plugin, file));
// Loaded on first use, so doctor can report a broken plugin instead of throwing on require.
for (const [file, names] of Object.entries(contract))
  for (const name of names)
    Object.defineProperty(exports, name, { enumerable: true, get: () => load(file)[name] });
Object.assign(exports, { plugin, launcher, hook, contract, reminderHelpers, load });
