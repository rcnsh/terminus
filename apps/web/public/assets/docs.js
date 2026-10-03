// The API docs page (/docs). On a phone the page itself scrolls (see the
// page's style), so picking an entry in the menu would leave the reader
// wherever they'd scrolled to in the last one: start each at the top.
window.addEventListener('hashchange', () => window.scrollTo(0, 0));
