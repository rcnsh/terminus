// Before the page draws: is the account page open inside the web app (its
// Settings tab, or the installed app)? Then it shows the app's bar along the
// bottom (assets/tabbar.css). Remembered for this tab, so it survives the
// page reloading itself.
(function () {
  var inApp = /[?&]in=app(&|$)/.test(location.search) || matchMedia('(display-mode: standalone)').matches;
  try {
    if (inApp) sessionStorage.setItem('terminus-in-app', '1');
    else inApp = sessionStorage.getItem('terminus-in-app') === '1';
  } catch {
    // Storage blocked: this page load only.
  }
  if (inApp) document.documentElement.classList.add('in-app');
})();
