// Only ever display the code; never send it anywhere from this page.
const c = (new URLSearchParams(location.search).get('code') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
if (c.length === 6) document.getElementById('code').textContent = c.slice(0, 3) + ' ' + c.slice(3);
