import "dotenv/config";
import type { LogLevel } from "@slack/bolt";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const allowed = ["debug", "info", "warn", "error"];
  const level = (value ?? "info").toLowerCase();
  if (!allowed.includes(level)) {
    throw new Error(
      `Invalid LOG_LEVEL "${value}". Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return level as LogLevel;
}

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackAppToken: required("SLACK_APP_TOKEN"),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  dbPath: process.env.DB_PATH ?? "./data/bumblebee.db",
};
