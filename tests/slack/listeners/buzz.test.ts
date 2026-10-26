import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newReminder, useTempDatabase } from "../../helpers/store.js";

useTempDatabase();

const { initDb } = await import("../../../src/store/database.js");
const {
  addSkip,
  getFireByMessageTs,
  getReminder,
  insertReminder,
  listHosts,
  listSkips,
  recordFire,
  replaceHosts,
  setReportNotice,
} = await import("../../../src/store/reminders.js");
const { recordBuzz } = await import("../../../src/slack/listeners/buzz.js");

initDb();

const MESSAGE_TS = "1700000000.0001";

describe("buzzing in", () => {
  it("leaves the host, the turn, the lap and the skips alone, even when the host clicks", () => {
    const reminder = newReminder();
    insertReminder(reminder);
    const stored = getReminder(reminder.channelId, reminder.code)!;
    replaceHosts(stored.id, ["U_A", "U_B", "U_C"], ["U_A", "U_B", "U_C"]);
    recordFire({
      reminderId: stored.id,
      firedOn: "2026-07-27",
      firedAt: new Date(),
      hostUserId: "U_A",
      messageTs: MESSAGE_TS,
      nextLap: ["U_B", "U_C"],
    });
    const fire = getFireByMessageTs(MESSAGE_TS)!;
    addSkip(fire.id, "U_C", null);
    const rosterBefore = listHosts(stored.id).map((host) => ({ ...host }));

    const notice = recordBuzz({
      fire,
      reminder: stored,
      clicker: "U_A",
      clickerName: "Alice",
      body: "shipped it",
      syncWith: ["U_B"],
    });

    const after = getFireByMessageTs(MESSAGE_TS)!;
    assert.equal(after.hostUserId, "U_A");
    assert.equal(after.turnUserId, "U_A");
    assert.deepEqual(listHosts(stored.id).map((host) => ({ ...host })), rosterBefore);
    assert.deepEqual(listSkips(fire.id).map((skip) => skip.userId), ["U_C"]);
    assert.equal(notice.noticeTs, null);
    assert.equal(
      notice.text,
      `🐝 Alice buzzed in on \`${stored.code}\`:\nshipped it\n🤝 Needs sync with <@U_B>`,
    );
    assert.equal(notice.syncPing, null);
  });

  it("names the buzzer as escaped text, so a name can't turn into a mention", () => {
    const { fire, reminder } = firedReminder("1700000000.0002");
    const notice = recordBuzz({ fire, reminder, clicker: "U_A", clickerName: "<!here> & co", body: "ok", syncWith: [] });
    assert.equal(notice.text, `🐝 &lt;!here&gt; &amp; co buzzed in on \`${reminder.code}\`:\nok`);
  });

  it("pings only the people an edit adds to sync-with", () => {
    const { fire, reminder } = firedReminder("1700000000.0003");
    const buzz = (syncWith: string[]) =>
      recordBuzz({ fire, reminder, clicker: "U_A", clickerName: "Alice", body: "ok", syncWith });

    assert.equal(buzz(["U_D"]).syncPing, null);
    setReportNotice(fire.id, "U_A", "1700000000.0099");

    const added = buzz(["U_D", "U_E"]);
    assert.equal(added.noticeTs, "1700000000.0099");
    assert.equal(added.syncPing, "🤝 Alice needs sync with <@U_E>");
    assert.equal(buzz(["U_D", "U_E"]).syncPing, null);
    assert.equal(buzz([]).syncPing, null);
  });
});

let reminderCount = 0;

function firedReminder(messageTs: string) {
  const reminder = newReminder({ code: `buzz-${++reminderCount}` });
  insertReminder(reminder);
  const stored = getReminder(reminder.channelId, reminder.code)!;
  recordFire({ reminderId: stored.id, firedOn: "2026-07-27", firedAt: new Date(), hostUserId: null, messageTs, nextLap: [] });
  return { fire: getFireByMessageTs(messageTs)!, reminder: stored };
}
