'use strict';

const form = document.querySelector('#add-form');
const search = document.querySelector('#search');
const list = document.querySelector('#bookmarks');
const errorBox = document.querySelector('#error');
const status = document.querySelector('#status');
let loadVersion = 0;

function showError(error) {
  errorBox.textContent = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `Request failed (${response.status}). Please try again.`;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
    } catch { /* Keep the useful HTTP status when the response is not JSON. */ }
    throw new Error(message);
  }
  return response.status === 204 ? undefined : response.json();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bookmarkItem(bookmark) {
  const item = element('li', 'bookmark');
  const link = element('a', '', bookmark.title);
  // Keep even unexpected API data from becoming an executable link.
  try {
    const url = new URL(bookmark.url);
    if (url.protocol === 'https:' || url.protocol === 'http:') link.href = url.href;
  } catch { /* Render the title as text when the URL is invalid. */ }
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  item.append(link, element('p', 'url', bookmark.url));
  const tags = element('div', 'tags');
  for (const tag of bookmark.tags) tags.append(element('span', 'tag', tag));
  const remove = element('button', 'delete', 'Delete');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Delete ${bookmark.title}`);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    errorBox.textContent = '';
    try {
      await request(`/api/bookmarks/${encodeURIComponent(bookmark.id)}`, { method: 'DELETE' });
      await loadBookmarks();
    } catch (error) {
      showError(error);
    } finally {
      remove.disabled = false;
    }
  });
  item.append(tags, remove);
  return item;
}

async function loadBookmarks() {
  const version = ++loadVersion;
  status.textContent = 'Loading bookmarks…';
  errorBox.textContent = '';
  try {
    const query = search.value.trim();
    const bookmarks = await request(`/api/bookmarks${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    if (version !== loadVersion) return;
    list.replaceChildren(...bookmarks.map(bookmarkItem));
    status.textContent = `${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`;
    if (!bookmarks.length) {
      list.append(element('li', 'empty', query ? 'No bookmarks match this search.' : 'Your next great find belongs here. Save your first bookmark.'));
    }
  } catch (error) {
    if (version !== loadVersion) return;
    status.textContent = 'Could not load bookmarks.';
    showError(error);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  errorBox.textContent = '';
  const fields = new FormData(form);
  try {
    await request('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: String(fields.get('url')).trim(),
        title: String(fields.get('title')).trim(),
        tags: String(fields.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      }),
    });
    form.reset();
    await loadBookmarks();
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
});

search.addEventListener('input', () => { void loadBookmarks(); });
void loadBookmarks();
