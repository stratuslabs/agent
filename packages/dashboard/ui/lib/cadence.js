/**
 * A schedule's cadence in words.
 *
 * The API sends `describeCadence`'s compact form: `every 30m`, `cron 0 9 *
 * * 1-5`, `once at <ISO time>` or `on <source> events`. The common cron
 * shapes read as a sentence; any other cron line is shown as itself rather
 * than guessed at, because a wrong "every day" is worse than the raw line.
 * Cron times are the daemon's own clock, so they are said as written.
 */

const UNITS = { s: ['second', 'seconds'], m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const twelveHour = (hour, minute) => {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown}:${String(minute).padStart(2, '0')} ${suffix}`;
};

const fromCron = (expression) => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return undefined;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const plain = (value, max) => /^\d+$/.test(value) && Number(value) <= max;
  if (dayOfMonth !== '*' || month !== '*') {
    return undefined;
  }
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && dayOfWeek === '*') {
    return `Every ${step[1]} minutes`;
  }
  if (plain(minute, 59) && hour === '*' && dayOfWeek === '*') {
    return `Every hour at :${minute.padStart(2, '0')}`;
  }
  if (!plain(minute, 59) || !plain(hour, 23)) {
    return undefined;
  }
  const at = twelveHour(Number(hour), Number(minute));
  if (dayOfWeek === '*') return `Every day at ${at}`;
  if (dayOfWeek === '1-5') return `Every weekday at ${at}`;
  if (plain(dayOfWeek, 7)) return `Every ${DAYS[Number(dayOfWeek)]} at ${at}`;
  return undefined;
};

export const humanCadence = (cadence) => {
  const text = String(cadence ?? '');
  const every = /^every (\d+)([smhd])$/.exec(text);
  if (every) {
    const count = Number(every[1]);
    const [one, many] = UNITS[every[2]];
    return count === 1 ? `Every ${one}` : `Every ${count} ${many}`;
  }
  if (text.startsWith('cron ')) {
    const expression = text.slice(5);
    return fromCron(expression) ?? `Cron ${expression}`;
  }
  if (text.startsWith('once at ')) {
    const at = new Date(text.slice(8));
    if (!Number.isNaN(at.getTime())) {
      return `Once on ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    }
  }
  if (text.startsWith('on ')) {
    return `On ${text.slice(3)}`;
  }
  return text;
};

/** Recurring, once, or event: the filter tabs on the Schedules page. */
export const cadenceKind = (cadence) => {
  const text = String(cadence ?? '');
  if (text.startsWith('once at ')) return 'once';
  if (text.startsWith('on ')) return 'event';
  return 'recurring';
};
