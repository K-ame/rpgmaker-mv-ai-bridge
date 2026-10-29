import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-ai-bridge-notes-'));
process.env.MV_AI_BRIDGE_HOME = HOME;
const { NotesStore } = await import('../dist/core.js');

const NOTES = path.join(HOME, 'notes.json');
const BACKUP = `${NOTES}.bak`;

function reset() {
  for (const name of fs.readdirSync(HOME)) {
    if (name.startsWith('notes.json')) fs.rmSync(path.join(HOME, name), { force: true });
  }
}

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('writes atomically and keeps the previous copy as a backup', () => {
  reset();
  const store = new NotesStore();
  store.set('Game', 'a', 1);

  const raw = JSON.parse(fs.readFileSync(NOTES, 'utf8'));
  assert.equal(raw.schema, 1);
  assert.equal(raw.games.Game.a.value, 1);
  assert.deepEqual(fs.readdirSync(HOME).filter((n) => n.includes('.tmp-')), []);

  store.set('Game', 'b', 2);
  assert.ok(fs.existsSync(BACKUP));
  const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  assert.equal(backup.games.Game.a.value, 1);
  assert.equal(backup.games.Game.b, undefined);
});

test('recovers from a corrupt file with the backup and keeps the corrupt copy', () => {
  reset();
  const first = new NotesStore();
  first.set('Game', 'a', { v: 1 });
  first.set('Game', 'b', 2);

  fs.writeFileSync(NOTES, '{not json', 'utf8');
  const second = new NotesStore();
  assert.equal(second.get('Game', 'a').value.v, 1);
  assert.equal(second.get('Game', 'b'), null);

  const status = second.status();
  assert.equal(status.status, 'recovered_backup');
  assert.ok(status.corrupt_copy && fs.existsSync(status.corrupt_copy));
  assert.equal(fs.readFileSync(status.corrupt_copy, 'utf8'), '{not json');
  assert.ok(status.warnings.some((w) => w.includes('restored from')));
});

test('keeps the corrupt file and starts empty when there is no backup', () => {
  reset();
  fs.writeFileSync(NOTES, '[1,2,3]', 'utf8');
  const store = new NotesStore();
  assert.deepEqual(store.list('Game'), {});

  const status = store.status();
  assert.equal(status.status, 'recovered_empty');
  assert.ok(status.warnings.some((w) => w.includes('could not be read')));
  assert.ok(status.corrupt_copy && fs.existsSync(status.corrupt_copy));
});

test('migrates a legacy file without losing entries', () => {
  reset();
  fs.writeFileSync(
    NOTES,
    JSON.stringify({
      games: { Game: { goal: { value: 'find the sword', updatedAt: '2026-01-01T00:00:00.000Z' } } },
    }),
    'utf8',
  );

  const store = new NotesStore();
  assert.equal(store.get('Game', 'goal').value, 'find the sword');
  assert.equal(store.status().status, 'migrated');

  store.set('Game', 'next', 'north gate');
  const raw = JSON.parse(fs.readFileSync(NOTES, 'utf8'));
  assert.equal(raw.schema, 1);
  assert.equal(raw.games.Game.goal.value, 'find the sword');
  assert.equal(raw.games.Game.next.value, 'north gate');
});

test('a missing file is a normal empty store, not a recovery warning', () => {
  reset();
  const store = new NotesStore();
  assert.deepEqual(store.list('Game'), {});
  const status = store.status();
  assert.equal(status.status, 'empty');
  assert.deepEqual(status.warnings, []);
});
