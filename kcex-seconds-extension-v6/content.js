(function() {
  try {
    const inject = () => {
      if (document.getElementById('kcex-sec-main-script')) return;
      const script = document.createElement('script');
      script.id = 'kcex-sec-main-script';
      script.src = chrome.runtime.getURL('injected.js');
      script.async = false;
      (document.head || document.documentElement).appendChild(script);
    };
    if (document.documentElement) {
      inject();
    } else {
      window.addEventListener('DOMContentLoaded', inject, { once: true });
    }
  } catch (e) {}
})();
