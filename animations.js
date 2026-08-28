(function () {
  'use strict';

  var contentEl = document.getElementById('content');
  if (contentEl) {
    var observer = new MutationObserver(function() {
      contentEl.classList.remove('page-enter');
      void contentEl.offsetWidth;
      contentEl.classList.add('page-enter');
      contentEl.addEventListener('animationend', function() {
        contentEl.classList.remove('page-enter');
        staggerCards(contentEl);
      }, { once: true });
    });
    observer.observe(contentEl, { childList: true, subtree: false });
  }

  function staggerCards(root) {
    var selectors = ['.ic','.news-card','.pipeline-card','.stat-card','.dash-widget'];
    selectors.forEach(function(sel) {
      var cards = root.querySelectorAll(sel);
      cards.forEach(function(card, i) {
        for (var n = 1; n <= 12; n++) card.classList.remove('stagger-' + n);
        card.classList.add('stagger-' + Math.min(i + 1, 12));
      });
    });
  }

  document.querySelectorAll('.nav-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var icon = item.querySelector('.nav-icon-box');
      if (!icon) return;
      icon.style.transition = 'transform .12s';
      icon.style.transform = 'scale(1.25)';
      setTimeout(function() { icon.style.transform = ''; }, 180);
    });
  });

  var statObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      var el = m.target.closest('.stat-value,.stat-num,h2,.text-2xl');
      if (el) {
        el.style.transition = 'transform .18s, color .18s';
        el.style.transform = 'scale(1.08)';
        el.style.color = 'var(--text2)';
        setTimeout(function() { el.style.transform = ''; el.style.color = ''; }, 250);
      }
    });
  });
  document.querySelectorAll('.stat-card').forEach(function(card) {
    statObserver.observe(card, { characterData: true, subtree: true, childList: true });
  });

  document.querySelectorAll('.overlay').forEach(function(overlay) {
    var innerObs = new MutationObserver(function() {
      if (overlay.classList.contains('open')) {
        var modal = overlay.querySelector('.modal');
        if (modal) { modal.style.animation = 'none'; void modal.offsetWidth; modal.style.animation = ''; }
      }
    });
    innerObs.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  setTimeout(function() { if (contentEl) staggerCards(contentEl); }, 120);

})();
