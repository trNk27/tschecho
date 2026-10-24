import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { WebSocket } from 'ws';
import { RoomManager, type Client } from '../server/rooms';

interface FakeWs {
  OPEN: number;
  readyState: number;
  sent: Record<string, unknown>[];
  closed: number | null;
  send(data: string): void;
  close(code?: number): void;
}

const managers: RoomManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.closeAll();
});

function setup() {
  const rm = new RoomManager();
  managers.push(rm);
  const connect = () => {
    const ws: FakeWs = {
      OPEN: 1,
      readyState: 1,
      sent: [],
      closed: null,
      send(data) {
        this.sent.push(JSON.parse(data));
      },
      close(code = 1000) {
        this.closed = code;
        this.readyState = 3;
      },
    };
    const client = rm.newClient(ws as unknown as WebSocket);
    const send = (msg: unknown) => rm.handleRaw(client, typeof msg === 'string' ? msg : JSON.stringify(msg));
    const last = (t: string) => [...ws.sent].reverse().find((m) => m.t === t) as Record<string, any> | undefined;
    const drop = () => {
      ws.readyState = 3;
      rm.handleClose(client);
    };
    return { ws, client, send, last, drop };
  };
  const host = () => {
    const h = connect();
    h.send({ t: 'host:create' });
    const room = h.last('host:room')!;
    return { ...h, room: room.room as string, token: room.token as string };
  };
  return { rm, connect, host };
}

const tick = (c: Client) => {
  // Refill the rate-limit bucket between bursts.
  c.lastRefill -= 2000;
};

test('host creates a room with a 4-letter code without look-alikes', () => {
  const { host } = setup();
  const h = host();
  assert.match(h.room, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
});

test('phones join, get slots and colours, and inputs reach the host with the right slot', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: '  Manuel  ' });
  const joined = a.last('joined')!;
  assert.equal(joined.slot, 1);
  assert.equal(joined.name, 'Manuel');
  assert.equal(h.last('player:joined')!.slot, 1);

  const b = connect();
  b.send({ t: 'ctrl:join', room: h.room, name: 'Max' });
  assert.equal(b.last('joined')!.slot, 2);

  b.send({ t: 'input', x: 0.5, y: -1, b: 3, seq: 1 });
  const input = h.last('input')!;
  assert.deepEqual(input, { t: 'input', slot: 2, x: 0.5, y: -1, b: 3, seq: 1 });
});

test('a fifth phone is rejected', () => {
  const { host, connect } = setup();
  const h = host();
  for (let i = 0; i < 4; i++) connect().send({ t: 'ctrl:join', room: h.room, name: `P${i}` });
  const e = connect();
  e.send({ t: 'ctrl:join', room: h.room, name: 'Late' });
  assert.equal(e.last('error')!.code, 'room-full');
});

test('reconnecting with the token returns the same slot; a made-up token gets a new slot', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'Manuel' });
  const { token, slot } = a.last('joined')!;
  a.drop();
  assert.deepEqual(h.last('player:left'), { t: 'player:left', slot, permanent: false });

  const again = connect();
  again.send({ t: 'ctrl:join', room: h.room, name: 'Whatever', token });
  const j = again.last('joined')!;
  assert.equal(j.slot, slot);
  assert.equal(j.name, 'Manuel');
  assert.equal(h.last('player:joined')!.reconnected, true);

  const fake = connect();
  fake.send({ t: 'ctrl:join', room: h.room, name: 'Eve', token: crypto.randomUUID() });
  assert.equal(fake.last('joined')!.slot, 2);
});

test('only the host may send host messages; phones cannot target other slots', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  const b = connect();
  b.send({ t: 'ctrl:join', room: h.room, name: 'B' });
  // A phone tries to send a host message and an input with a slot field.
  a.send({ t: 'haptic', slot: 2, pattern: 'hit' });
  a.send({ t: 'input', x: 0, y: 0, b: 0, seq: 1, slot: 2 });
  assert.equal(b.last('haptic'), undefined);
  assert.equal(a.last('error')!.code, 'invalid');
  // The host can.
  h.send({ t: 'haptic', slot: 2, pattern: 'hit' });
  assert.equal(b.last('haptic')!.pattern, 'hit');
  h.send({ t: 'hud', slot: 1, hp: 50, food: 20, item: null, hint: 'Hold A: chop', gear: '', a: 'Chop', b: '', c: '', downed: false, progress: 0 });
  assert.equal(a.last('hud')!.hint, 'Hold A: chop');
  assert.equal(b.last('hud'), undefined);
});

test('junk is dropped and a socket that keeps sending junk is closed', () => {
  const { connect } = setup();
  const c = connect();
  for (let i = 0; i < 25; i++) {
    c.send('{not json');
    tick(c.client);
  }
  assert.equal(c.ws.closed, 1008);
});

test('out-of-range values are rejected by the schema', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  const before = h.ws.sent.length;
  a.send({ t: 'input', x: 5, y: 0, b: 0, seq: 1 });
  a.send({ t: 'input', x: 0, y: 0, b: 99, seq: 2 });
  assert.equal(h.ws.sent.length, before);
});

test('rate limit drops floods', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  const before = h.ws.sent.length;
  for (let i = 0; i < 500; i++) a.send({ t: 'input', x: 0, y: 0, b: 0, seq: i + 1 });
  const forwarded = h.ws.sent.length - before;
  assert.ok(forwarded < 120, `forwarded ${forwarded}`);
  assert.equal(a.ws.closed, 1008);
});

test('host can resume its room after a reload; phones see host status', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  h.drop();
  assert.equal(a.last('host:status')!.online, false);
  const h2 = connect();
  h2.send({ t: 'host:resume', room: h.room, token: h.token });
  const r = h2.last('host:room')!;
  assert.equal(r.resumed, true);
  assert.equal(r.players.length, 1);
  assert.equal(a.last('host:status')!.online, true);

  const bad = connect();
  bad.send({ t: 'host:resume', room: h.room, token: crypto.randomUUID() });
  assert.equal(bad.last('error')!.code, 'room-not-found');
});

test('game state is relayed and resets ready flags when a run starts', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  a.send({ t: 'ctrl:ready', ready: true });
  assert.equal(h.last('player:ready')!.ready, true);
  h.send({ t: 'game:state', state: 'day', night: 1, nights: 5 });
  assert.equal(a.last('game:state')!.state, 'day');
  // A late phone gets the current state immediately and is not ready.
  const b = connect();
  b.send({ t: 'ctrl:join', room: h.room, name: 'B' });
  assert.equal(b.last('game:state')!.state, 'day');
  a.drop();
  const a2 = connect();
  a2.send({ t: 'ctrl:join', room: h.room, name: 'A', token: a.last('joined')!.token });
  assert.equal(a2.last('joined')!.ready, false);
});

test('kick removes a player and frees the slot', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: h.room, name: 'A' });
  h.send({ t: 'host:kick', slot: 1 });
  assert.equal(a.last('room:closed')!.reason, 'kicked');
  assert.equal(h.last('player:left')!.permanent, true);
  const b = connect();
  b.send({ t: 'ctrl:join', room: h.room, name: 'B' });
  assert.equal(b.last('joined')!.slot, 1);
});

test('unknown rooms and empty names are rejected', () => {
  const { host, connect } = setup();
  const h = host();
  const a = connect();
  a.send({ t: 'ctrl:join', room: 'ZZZZ', name: 'A' });
  assert.equal(a.last('error')!.code, 'room-not-found');
  const b = connect();
  b.send({ t: 'ctrl:join', room: h.room, name: '   ' });
  assert.equal(b.last('error')!.code, 'bad-name');
});
