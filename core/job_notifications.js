'use strict';
const fs = require('fs');
const path = require('path');

function createJobNotifications(file) {
  let state = { schema: 1, seq: 0, seen: {}, notifications: [] };
  if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8'));
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), 'utf8'); fs.renameSync(file + '.tmp', file);
  }
  function observe(event) {
    const job = event.job;
    if (!job || !job.id) return;
    const fingerprint = [job.status, job.attempts || 0, job.recoveryCount || 0].join(':');
    if (state.seen[job.id] === fingerprint) return;
    state.seen[job.id] = fingerprint;
    if (['succeeded', 'failed', 'needs_review', 'cancelled'].includes(job.status) || event.type === 'reclaim') {
      state.notifications.push({ id: 'notice_' + (++state.seq), type: event.type, at: Date.now(), read: false,
        job: { id: job.id, label: job.label, status: job.status, attempts: job.attempts || 0,
          session_id: job.session_id || null, project_id: job.project_id || null } });
      state.notifications = state.notifications.slice(-200);
    }
    save();
  }
  function snapshot(scope = {}) {
    const notifications = state.notifications.filter(n => (!scope.session_id || n.job.session_id === scope.session_id)
      && (!scope.project_id || n.job.project_id === scope.project_id));
    return { notifications: notifications.slice(-100).reverse().map(n => ({ ...n, job: { ...n.job } })), unread: notifications.filter(n => !n.read).length };
  }
  function ack(ids) {
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('通知 ids 需为不超过200项的数组');
    const selected = new Set(ids); let changed = false;
    for (const row of state.notifications) if (selected.has(row.id) && !row.read) { row.read = true; changed = true; }
    if (changed) save(); return { ok: true };
  }
  return { observe, snapshot, ack };
}
module.exports = { createJobNotifications };
