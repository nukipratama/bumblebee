import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useTempDatabase } from "../helpers/store.js";

useTempDatabase();

const { initDb, stmt, transaction } = await import("../../src/store/database.js");
const { insertHoliday, listHolidayDates } = await import("../../src/store/reminders.js");

initDb();

beforeEach(() => {
  stmt("DELETE FROM holidays").run();
});

const addHoliday = (date: string): void =>
  insertHoliday({ date, addedBy: "U1", addedInChannel: "C1" });

describe("transaction", () => {
  it("commits every write once the callback returns", () => {
    transaction(() => addHoliday("2026-01-01"));
    assert.deepEqual(listHolidayDates(), new Set(["2026-01-01"]));
  });

  it("rolls back every write when the callback throws", () => {
    assert.throws(() => {
      transaction(() => {
        addHoliday("2026-01-01");
        throw new Error("boom");
      });
    });
    assert.deepEqual(listHolidayDates(), new Set());
  });

  it("lets a nested call join the outer transaction instead of starting its own", () => {
    transaction(() => {
      addHoliday("2026-01-01");
      transaction(() => addHoliday("2026-01-02"));
    });
    assert.deepEqual(listHolidayDates(), new Set(["2026-01-01", "2026-01-02"]));
  });

  it("rolls back the whole outer transaction when a nested call throws", () => {
    assert.throws(() => {
      transaction(() => {
        addHoliday("2026-01-01");
        transaction(() => {
          throw new Error("boom");
        });
      });
    });
    assert.deepEqual(listHolidayDates(), new Set());
  });
});
