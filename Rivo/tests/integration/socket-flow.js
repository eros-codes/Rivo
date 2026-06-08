// Integration test scaffold for socket flows.
// Usage:
// TEST_SERVER_URL=http://localhost:3000 TEST_USER_A=alice TEST_PASS_A=passA TEST_USER_B=bob TEST_PASS_B=passB node tests/integration/socket-flow.js

import { io } from 'socket.io-client';

const SERVER = process.env.TEST_SERVER_URL || 'http://localhost:3000';
const USER_A = process.env.TEST_USER_A;
const PASS_A = process.env.TEST_PASS_A;
const USER_B = process.env.TEST_USER_B;
const PASS_B = process.env.TEST_PASS_B;

if (!USER_A || !PASS_A || !USER_B || !PASS_B) {
  console.error('Please set TEST_SERVER_URL, TEST_USER_A, TEST_PASS_A, TEST_USER_B, TEST_PASS_B');
  process.exit(1);
}

// Helper: login, optionally create user when CREATE_TEST_USERS=1
async function loginAndGetCookie(user, pass) {
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user, password: pass }),
  });

  if (!res.ok) {
    throw new Error(`login failed for ${user}: ${res.status}`);
  }

  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('No set-cookie header received');
  return raw.split(',').map(s => s.split(';')[0]).join('; ');
}

async function tryEnsureUser(user, pass) {
  try {
    return await loginAndGetCookie(user, pass);
  } catch (e) {
    if (process.env.CREATE_TEST_USERS === '1' || process.env.CREATE_TEST_USERS === 'true') {
      console.log(`Attempting to register ${user} because login failed`);
      const reg = await fetch(`${SERVER}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: user, email: `${user}@example.test`, username: user, password: pass }),
      });
      if (!reg.ok && reg.status !== 409) {
        throw new Error(`Failed to register ${user}: ${reg.status}`);
      }
      return await loginAndGetCookie(user, pass);
    }
    throw e;
  }
}

async function createOrGetConversation(cookie, otherUsername) {
  // Try creating contact
  // Extract CSRF token from cookie (double-submit cookie pattern)
  const csrfMatch = String(cookie).match(/csrfToken=([^;\s]+)/);
  const csrf = csrfMatch ? csrfMatch[1] : null;
  const res = await fetch(`${SERVER}/api/contacts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ username: otherUsername }),
  });

  if (res.ok) {
    const json = await res.json();
    return json.conversationId || json.conversation?.id;
  }

  // If already exists or other error, list contacts and find the conversation
  if (res.status === 409 || res.status === 200 || res.status === 400) {
    const list = await fetch(`${SERVER}/api/contacts`, { headers: { Cookie: cookie } });
    if (!list.ok) throw new Error('Failed to list contacts');
    const arr = await list.json();
    const found = arr.find((c) => c.contact && (c.contact.username === otherUsername || c.contact?.username === otherUsername));
    return found?.conversationId || found?.conversation?.id;
  }

  const body = await res.text();
  throw new Error(`createOrGetConversation failed: ${res.status} ${body}`);
}

function emitWithAck(socket, event, payload, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('ack timeout: ' + event));
      }
    }, timeout);
    try {
      socket.emit(event, payload, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(resp);
      });
    } catch (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    }
  });
}

function waitForEvent(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEv);
      reject(new Error('timeout waiting for ' + event));
    }, timeout);
    function onEv(data) {
      clearTimeout(timer);
      resolve(data);
    }
    socket.once(event, onEv);
  });
}

(async () => {
  try {
    const cookieA = await tryEnsureUser(USER_A, PASS_A);
    const cookieB = await tryEnsureUser(USER_B, PASS_B);

    console.log('Logged in and retrieved cookies');
    console.log('cookieA:', cookieA);
    console.log('cookieB:', cookieB);

    const conversationId = await createOrGetConversation(cookieA, USER_B);
    if (!conversationId) throw new Error('Failed to determine conversationId');
    console.log('Conversation ID:', conversationId);

    const sockA = io(SERVER, { extraHeaders: { Cookie: cookieA }, withCredentials: true });
    const sockB = io(SERVER, { extraHeaders: { Cookie: cookieB }, withCredentials: true });

    sockA.on('connect_error', (err) => console.error('A connect_error', err && err.message ? err.message : err));
    sockB.on('connect_error', (err) => console.error('B connect_error', err && err.message ? err.message : err));

    await new Promise((resolve) => {
      let connected = 0;
      function check() { if (++connected === 2) resolve(); }
      sockA.on('connect', () => { console.log('A connected'); check(); });
      sockB.on('connect', () => { console.log('B connected'); check(); });
    });

    // Ensure both sockets join the conversation room
    await Promise.all([
      emitWithAck(sockA, 'conversation:join', { conversationId }).catch(() => {}),
      emitWithAck(sockB, 'conversation:join', { conversationId }).catch(() => {}),
    ]);

    // 1) Send a message from A and expect B to receive it
    const text = 'hello from A ' + Date.now();
    const newMsgPromise = waitForEvent(sockB, 'message:new', 5000);
    const ack = await emitWithAck(sockA, 'message:send', { conversationId, text });
    if (!ack || ack.error || !ack.message) throw new Error('message:send failed: ' + JSON.stringify(ack));
    const sent = ack.message;
    const recv = await newMsgPromise;
    console.log('B received message:', recv.id);

    // 2) Edit message and expect B to receive edit notification
    const editPromise = waitForEvent(sockB, 'message:edited', 5000);
    const editAck = await emitWithAck(sockA, 'message:edit', { messageId: sent.id, text: text + ' (edited)' });
    if (!editAck || editAck.error) throw new Error('message:edit failed: ' + JSON.stringify(editAck));
    const editEvent = await editPromise;
    console.log('B received edit:', editEvent);

    // 3) Pin message -> B should receive pinned event
    const pinPromise = waitForEvent(sockB, 'message:pinned', 5000);
    const pinAck = await emitWithAck(sockA, 'message:pin', { messageId: sent.id });
    if (!pinAck || pinAck.error) throw new Error('message:pin failed');
    const pinEvent = await pinPromise;
    console.log('B received pin event:', pinEvent);

    // 4) Typing: A starts typing, B should receive typing:start
    const typingPromise = waitForEvent(sockB, 'typing:start', 5000);
    sockA.emit('typing:start', { conversationId });
    const typingEvent = await typingPromise;
    console.log('B received typing start:', typingEvent.userId);

    // 5) Message seen: B marks seen and A should receive message:seen
    const seenPromiseA = waitForEvent(sockA, 'message:seen', 5000);
    const seenAck = await emitWithAck(sockB, 'message:seen', { conversationId });
    if (!seenAck || seenAck.error) throw new Error('message:seen ack failed');
    const seenEvent = await seenPromiseA;
    console.log('A received seen event for ids:', seenEvent.messageIds || seenAck.marked);

    // Cleanup
    sockA.close();
    sockB.close();
    console.log('Integration test finished successfully');
    process.exit(0);
  } catch (e) {
    console.error('Integration test error', e);
    process.exit(1);
  }
})();
