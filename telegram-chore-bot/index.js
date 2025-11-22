/**
 * Entry point for the Telegram chore bot.
 * The bot keeps a simple in-memory schedule, pushes reminders on a cron
 * schedule, and lets users report completions via natural language text.
 */
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
// Fail fast when the bot token is missing so the process does not run silently.
if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set in the environment.');
}
// All user-facing timestamps rely on this shared timezone.
const TIME_ZONE = process.env.TIMEZONE || 'Asia/Kuala_Lumpur';
const bot = new Telegraf(process.env.BOT_TOKEN);
// Keeps track of chats that interacted with the bot so they can receive reminders.
const subscribedChats = new Set();
const PENALTY_AMOUNT = 6;
const penaltyFilePath = path.join(__dirname, 'punishments.json');
const loadPunishments = () => {
  try {
    const data = fs.readFileSync(penaltyFilePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to load punishment ledger:', err.message);
    }
    return {};
  }
};
let punishmentLedger = loadPunishments();
const persistPunishments = () => {
  try {
    fs.writeFileSync(penaltyFilePath, JSON.stringify(punishmentLedger, null, 2));
  } catch (err) {
    console.error('Failed to persist punishment ledger:', err.message);
  }
};
const formatPunishmentLedger = () => {
  const entries = Object.entries(punishmentLedger).filter(([, amount]) => amount > 0);
  if (!entries.length) {
    return '🎉 No outstanding punishments. Keep up the good work!';
  }
  const rows = entries
    .sort(([personA], [personB]) => personA.localeCompare(personB))
    .map(([person, amount]) => `• ${person}: RM${amount.toFixed(2)}`);
  return `💸 Punishment ledger:\n${rows.join('\n')}`;
};
// Static weekly rotation defining every chore and its owner.
const weeklyTemplate = {
  Monday: [
    { task: 'Vacuum', person: 'Ezlan' },
    { task: 'Kitchen', person: 'Alif' },
    { task: 'Mop', person: 'Shafwan' },
  ],
  Tuesday: [
    { task: 'Toilet', person: 'Ezlan' },
  ],
  Wednesday: [
    { task: 'Vacuum', person: 'Alif' },
    { task: 'Kitchen', person: 'Shafwan' },
    { task: 'Mop', person: 'Ezlan' },
  ],
  Thursday: [
    { task: 'Toilet', person: 'Alif' },
  ],
  Friday: [
    { task: 'Vacuum', person: 'Shafwan' },
    { task: 'Kitchen', person: 'Ezlan' },
    { task: 'Mop', person: 'Alif' },
  ],
  Saturday: [
    { task: 'Toilet', person: 'Shafwan' },
  ],
  Sunday: [],
};

const canonicalPeople = Array.from(new Set(
  Object.values(weeklyTemplate).flatMap((assignments) => assignments.map((entry) => entry.person)),
));
// Cheat sheet sent to users when they ask for help or interact with the bot.
const helpMessage = [
  '🧹 I keep everyone on track with daily chores.',
  '⏰ Automatic reminders at 8:00 AM, 6:00 PM, and 11:00 PM',
  '✅ Send "<person> completed <chore>" to update progress',
  '? Send "<person> paid punishment" once fines are settled',
  '',
  'Commands:',
  '🔹 /start - Fire up the bot',
  '🔹 /today - show today\'s assignments',
  '🔹 /weeklyschedule - view the weekly rotation',
  '🔹 /punishments - view outstanding RM6 penalties',
  '🔹 /ping - check if I am alive',
].join('\n');
// Telegram custom keyboard for quick access to the supported commands.
const commandKeyboard = Markup.keyboard([
  ['/start', '/today', '/weeklyschedule'],
  ['/punishments', '/ping']
]).resize();
// Parses messages like "Alif completed Vacuum".
const completionRegex = /^\s*([a-zA-Z]+)\s+completed\s+([a-zA-Z\s]+?)\s*$/i;
const paymentRegex = /^\s*([a-zA-Z]+)\s+paid\s+punishment\s*$/i;
// These keep the daily progress in memory and reset when the date changes.
let currentDayName = null;
let todayState = [];
// Determines the day name (Monday, Tuesday, ...) for the configured timezone.
const getCurrentDayName = () => new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  timeZone: TIME_ZONE,
}).format(new Date());
/**
 * Lazily ensures the in-memory state for today's chores is up to date.
 * When the day changes, the template is copied and tracking metadata added.
 */
const ensureTodayState = () => {
  const today = getCurrentDayName();
  if (today !== currentDayName) {
    currentDayName = today;
    const template = weeklyTemplate[today] || [];
    // Clone the template so the in-memory state can track completion metadata.
    todayState = template.map((assignment) => ({
      ...assignment,
      status: 'Pending',
      completedAt: null,
    }));
    console.log(`Initialized chores for ${today}`);
  }
  return todayState;
};
// Helper that normalizes text for case-insensitive matching.
const normalize = (text) => text.trim().toLowerCase();

const getCanonicalPersonName = (personInput) => {
  const normalizedTarget = normalize(personInput);
  const ledgerMatch = Object.keys(punishmentLedger).find(
    (name) => normalize(name) === normalizedTarget,
  );
  if (ledgerMatch) {
    return ledgerMatch;
  }
  const templateMatch = canonicalPeople.find((name) => normalize(name) === normalizedTarget);
  if (templateMatch) {
    return templateMatch;
  }
  return personInput.trim();
};
// Formats times such as completion timestamps using the shared timezone.
const formatTime = (date) => new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: TIME_ZONE,
}).format(date);
/**
 * Builds a human-readable list of today's chores, including completion status.
 * The summary is reused for commands, replies, and scheduled reminders.
 */
const formatDailySummary = () => {
  const state = ensureTodayState();
  const heading = `🧹 Daily chores for ${currentDayName}`;

  if (!state.length) {
    return `${heading}:\n\n- ✅ No chores scheduled. Enjoy the day!`;
  }

  const lines = state.map((entry) => {
    const statusLabel = entry.status === 'Completed'
      ? ' ✅ Done'
      : entry.status === 'Missed'
        ? ' ⚠️ Missed'
        : ' ⏳ Pending';

    const completionInfo = entry.status === 'Completed' && entry.completedAt
      ? ` (done at ${formatTime(entry.completedAt)})`
      : entry.status === 'Missed'
        ? ' (missed - RM6 penalty applied)'
        : '';

    return `- ${getTaskEmoji(entry.task)} ${entry.task} – ${entry.person}${statusLabel}${completionInfo}`;
  });

  return `${heading}:\n${lines.join('\n')}`;
};

const getTaskEmoji = (task) => {
  const lowerTask = task.toLowerCase();
  if (lowerTask.includes('toilet')) return '🚽';
  if (lowerTask.includes('kitchen')) return '🍽️';
  if (lowerTask.includes('vacuum')) return '🧼';
  if (lowerTask.includes('mop')) return '🪣';
  return '📝';
};

const formatWeeklySchedule = () => Object.entries(weeklyTemplate)
  .map(([day, assignments]) => {
    const dayEmoji = ({
      Monday: '🌞',
      Tuesday: '🌮',
      Wednesday: '🐪',
      Thursday: '🌤️',
      Friday: '🎉',
      Saturday: '🛋️',
      Sunday: '😌',
    })[day] || '📌';
    const title = `${dayEmoji} ${day}`;
    if (!assignments.length) {
      return `${title}:\n\n- ✅ No chores`;
    }
    const rows = assignments.map((item) => `- ${getTaskEmoji(item.task)} ${item.task} – ${item.person}`);
    return `${title}:\n\n${rows.join('\n')}`;
  })
  .join('\n\n');

const clearPunishmentForPerson = (personInput) => {
  const canonicalName = getCanonicalPersonName(personInput);
  const ledgerValue = punishmentLedger[canonicalName] || 0;

  if (!ledgerValue) {
    return `❓ ${canonicalName} has no outstanding punishment to clear.`;
  }

  punishmentLedger[canonicalName] = 0;
  persistPunishments();
  return `✅ Recorded that ${canonicalName} paid RM${ledgerValue.toFixed(2)}. Ledger updated.`;
};

const markCompletion = (personInput, taskInput) => {
  const state = ensureTodayState();
  if (!state.length) {
    return { error: '⚠️ There are no chores scheduled today.' };
  }
  const person = normalize(personInput);
  const task = normalize(taskInput);
  // Match based on normalized person+task pair so order or casing differences do not matter.
  const entry = state.find(
    (item) => normalize(item.person) === person && normalize(item.task) === task,
  );
  if (!entry) {
    return { error: `⚠️ I could not find "${taskInput.trim()}" assigned to ${personInput.trim()} today.` };
  }
  if (entry.status === 'Missed') {
    return { message: `Penalty already recorded for ${entry.task} (${entry.person}).` };
  }
  if (entry.status === 'Completed') {
    return { message: `ℹ️ ${entry.task} for ${entry.person} was already marked completed.` };
  }
  entry.status = 'Completed';
  entry.completedAt = new Date();
  // Helps callers know whether to send the celebratory "all done" message.
  const everyoneDone = state.every((item) => item.status === 'Completed');
  return {
    message: `✅ Great! Marked ${entry.task} for ${entry.person} as completed.`,
    everyoneDone,
  };
};
/**
 * Sends a reminder (e.g., "8:00 AM") to every subscribed chat.
 * Failures are logged but do not stop the rest of the chats from receiving it.
 */
const sendReminder = (label) => {
  const summary = formatDailySummary();
  const footer = '📝 Reply with "<person> completed <chore>" when you finish a task.';
  const message = `🔔 Reminder (${label})\n${summary}\n\n${footer}`;
  subscribedChats.forEach((chatId) => {
    bot.telegram.sendMessage(chatId, message).catch((err) => {
      console.error(`Failed to send reminder to ${chatId}:`, err.message);
    });
  });
};
// Three daily cron entries; easy to extend if the schedule ever changes.
const reminderSchedule = [
  { cron: '0 8 * * *', label: '8:00 AM' },
  { cron: '15 13 * * *', label: '1:15 PM' },
  { cron: '22 13 * * *', label: '1:22 PM' },
  { cron: '0 18 * * *', label: '6:00 PM' },
  { cron: '0 23 * * *', label: '11:00 PM' },
];
// Register every cron job and guard against running when nobody subscribed yet.
reminderSchedule.forEach(({ cron: cronExpr, label }) => {
  cron.schedule(cronExpr, () => {
    ensureTodayState();
    if (subscribedChats.size > 0) {
      sendReminder(label);
    }
  }, { timezone: TIME_ZONE });
});

cron.schedule('22 14 * * *', () => {
  applyDailyPunishments();
}, { timezone: TIME_ZONE });
// Adds the chat to the reminder set if the metadata is available.
const registerChat = (ctx) => {
  if (ctx.chat && ctx.chat.id) {
    subscribedChats.add(ctx.chat.id);
  }
};
// /start greets the user, subscribes them, and shares the current summary.
bot.start((ctx) => {
  registerChat(ctx);
  const name = (ctx.from && ctx.from.first_name) || 'there';
  const summary = formatDailySummary();
  ctx.reply(
    `🙌 Hi Everyone! I'm your daily chore assistant.\n${helpMessage}\n\n${summary}`,
    commandKeyboard,
  );
});
// Presents the current-day summary on demand.
bot.command('today', (ctx) => {
  registerChat(ctx);
  ctx.reply(formatDailySummary());
});
// Dumps the weekly rotation so everyone can see upcoming work.
bot.command('weeklyschedule', (ctx) => {
  registerChat(ctx);
  ctx.reply(`🗂️ Weekly plan:\n \n${formatWeeklySchedule()}`);
});

bot.command('punishments', (ctx) => {
  registerChat(ctx);
  ctx.reply(formatPunishmentLedger());
});
// Simple liveliness probe.
bot.command('ping', (ctx) => ctx.reply('pong'));
// Natural language hook such as "Ezlan completed Toilet".
bot.hears(completionRegex, (ctx) => {
  registerChat(ctx);
  const [, person, task] = ctx.match;
  const result = markCompletion(person, task);
  if (result.error) {
    return ctx.reply(result.error);
  }
  let message = result.message;
  if (result.everyoneDone) {
    message += '\n🎉 All chores for today are completed. Great job!';
  } else {
    // Remind the room how many chores remain so focus stays on the backlog.
    const pending = ensureTodayState().filter((item) => item.status === 'Pending').length;
    message += `\n⏳ Still pending: ${pending} chore(s).`;
  }
  return ctx.reply(message);
});

bot.hears(paymentRegex, (ctx) => {
  registerChat(ctx);
  const [, person] = ctx.match;
  const message = clearPunishmentForPerson(person);
  return ctx.reply(message);
});
// Fallback for any other text so users always know what to do next.
bot.on('text', (ctx) => {
  ctx.reply(
    `Need something else? 😊\n${helpMessage}\n\nYou can also type "<person> completed <chore>" to update progress or "<person> paid punishment" after settling fines.`,
    commandKeyboard,
  );
});
// Boot the bot, prime today's state, and log success/failure.
bot.launch()
  .then(() => {
    ensureTodayState();
    console.log('Bot is running with daily reminders enabled.');
  })
  .catch((err) => console.error('Bot failed to start:', err));
// Gracefully stop when the hosting platform sends termination signals.
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
