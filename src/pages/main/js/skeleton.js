// Lightweight helpers to create skeleton DOM fragments for various lists
export function makeContactSkeleton(count = 6) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const card = document.createElement('span');
    card.className = 'contacts-card skeleton-placeholder';

    // avatar placeholder
    const avatar = document.createElement('div');
    avatar.className = 'contact-profile skeleton';

    // name placeholder
    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-name';
    const nameLine = document.createElement('div');
    nameLine.className = 'skel-line skeleton';
    nameLine.style.width = `${55 + (i % 3) * 10}%`;
    nameSpan.appendChild(nameLine);

    // last message placeholder
    const msgSpan = document.createElement('span');
    msgSpan.className = 'contact-message';
    const last = document.createElement('span');
    last.className = 'last-message';
    const lastLine = document.createElement('div');
    lastLine.className = 'skel-line skeleton';
    lastLine.style.width = `${40 + (i % 3) * 12}%`;
    last.appendChild(lastLine);
    msgSpan.appendChild(last);

    card.appendChild(avatar);
    card.appendChild(nameSpan);
    card.appendChild(msgSpan);

    frag.appendChild(card);
  }
  return frag;
}

export function makeActiveChatSkeleton(count = 4) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'active-chat-wrapper skeleton-placeholder';

    const leftActions = document.createElement('div');
    leftActions.className = 'card-actions card-actions--left';

    const active = document.createElement('div');
    active.className = 'active-chat skeleton-placeholder';
    active.dataset.userId = '';

    const img = document.createElement('div');
    img.className = 'active-chat-profile skeleton';

    const info = document.createElement('span');
    info.className = 'active-chat-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'active-chat-name';
    const nameLine = document.createElement('div');
    nameLine.className = 'skel-line skeleton';
    nameLine.style.width = `${45 + (i % 3) * 12}%`;
    nameEl.appendChild(nameLine);
    const lastEl = document.createElement('span');
    lastEl.className = 'active-chat-last-message';
    const lastLine = document.createElement('div');
    lastLine.className = 'skel-line skeleton';
    lastLine.style.width = `${30 + (i % 3) * 12}%`;
    lastEl.appendChild(lastLine);
    info.appendChild(nameEl);
    info.appendChild(lastEl);

    const meta = document.createElement('span');
    meta.className = 'active-chat-meta';
    const timeEl = document.createElement('span');
    timeEl.className = 'active-chat-message-time skel-line skeleton';
    timeEl.style.width = '40px';
    meta.appendChild(timeEl);

    active.appendChild(img);
    active.appendChild(info);
    active.appendChild(meta);

    wrapper.appendChild(leftActions);
    wrapper.appendChild(active);
    // placeholder for right-side actions (make the element explicit for clarity)
    const rightActions = document.createElement('div');
    rightActions.className = 'card-actions card-actions--right';
    wrapper.appendChild(rightActions);

    frag.appendChild(wrapper);
  }
  return frag;
}

export function makeMessageSkeleton(count = 8) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const msg = document.createElement('div');
    msg.className = 'chat-message ' + (i % 2 ? 'outgoing' : 'incoming') + ' skeleton-placeholder';

    const text = document.createElement('div');
    text.className = 'chat-message-text skeleton skel-line';
    text.style.width = `${40 + (i % 4) * 12}%`;
    text.style.minHeight = `${20 + (i % 3) * 8}px`;

    const meta = document.createElement('div');
    meta.className = 'chat-message-meta skeleton';
    const time = document.createElement('span');
    time.className = 'chat-message-time skel-line skeleton';
    time.style.width = '36px';
    meta.appendChild(time);

    msg.appendChild(text);
    msg.appendChild(meta);
    frag.appendChild(msg);
  }
  return frag;
}

export function createTopMessageSkeleton() {
  const wrapper = document.createElement('div');
  wrapper.className = 'skeleton-top skeleton-placeholder';
  const msg = document.createElement('div');
  msg.className = 'chat-message incoming skeleton-placeholder';
  const line = document.createElement('div');
  line.className = 'chat-message-text skeleton skel-line';
  line.style.width = '38%';
  line.style.minHeight = '28px';
  msg.appendChild(line);
  wrapper.appendChild(msg);
  return wrapper;
}
